// main-thread.js
//
// Cross-thread "data-channel mode" adapter for the main thread (see the
// project plan, Phase 3). Ports the engine-lifecycle wiring from
// lynx-examples/examples/vanilla/src/common/main-thread/setup.ts, adapted so
// the app supplies a Mithril root component instead of hand-written
// renderPage/updatePage functions: Mithril's own redraw/diff machinery
// (already ported in ../src/lynx-mithril-shim.js) does the update work.
//
// The app is responsible for reading live data inside its Mithril view()
// functions via getData() — exactly like any plain-JS Mithril store, no
// special re-invocation of a "mount" function is needed on every update.

import shim from "./src/lynx-mithril-shim.js";
import {
	callBackgroundEventName,
	callBackgroundResultEventName,
	callMainThreadEventName,
	callMainThreadResultEventName,
	destroyLifetimeEventName,
	dispatchEventToBackgroundEventName,
	renderPageEventName,
	updateDataFromBackgroundEventName,
	updateDataFromMainThreadEventName,
	updatePageEventName,
} from "./internal/constants.js";

let latestData;

// The native engine unconditionally invokes a global `processData(initData)`
// hook on every __RenderPage/__UpdatePage, regardless of framework. Install a
// pass-through default immediately so apps that don't need to transform
// incoming data (the common case) don't have to think about this at all.
Object.assign(globalThis, {
	processData: (data) => data,
});

export function getData() {
	return latestData;
}

export function dispatchToBackground(handlerName, data) {
	lynx.getJSContext().dispatchEvent({
		type: dispatchEventToBackgroundEventName,
		data: { handlerName, data },
	});
}

export function setupApp(options) {
	const { root, processData, enableBackgroundSync = true } = options;
	const engine = lynx.getEngine();
	const background = enableBackgroundSync ? lynx.getJSContext() : undefined;
	let rendered = false;

	const applyData = (data) => {
		latestData = typeof processData === "function" ? processData(data) : data;
		if (enableBackgroundSync) {
			lynx.getJSContext().dispatchEvent({
				type: updateDataFromMainThreadEventName,
				data: latestData,
			});
		}
		return latestData;
	};

	const onRenderPage = (event) => {
		const [data] = event.data;
		applyData(data);
		const page = __CreatePage("0", 0);
		shim.renderToPage(page, root());
		rendered = true;
	};

	const onUpdatePage = (event) => {
		const [data] = event.data;
		applyData(data);
		if (rendered) shim.redraw();
	};

	const onDataFromBackground = (event) => {
		latestData = { ...latestData, ...event.data };
		if (rendered) shim.redraw();
	};

	const onDestroyLifetime = () => {
		if (enableBackgroundSync) {
			// The background thread has no lynx.getEngine() of its own, so relay
			// the native lifecycle event across the channel explicitly — this is
			// what lets background.js's own setupBackground() cleanup run.
			background.dispatchEvent({ type: destroyLifetimeEventName, data: undefined });
			background.removeEventListener(updateDataFromBackgroundEventName, onDataFromBackground);
		}
		engine.removeEventListener(renderPageEventName, onRenderPage);
		engine.removeEventListener(updatePageEventName, onUpdatePage);
		engine.removeEventListener(destroyLifetimeEventName, onDestroyLifetime);
	};

	engine.addEventListener(renderPageEventName, onRenderPage);
	engine.addEventListener(updatePageEventName, onUpdatePage);
	engine.addEventListener(destroyLifetimeEventName, onDestroyLifetime);
	if (enableBackgroundSync) {
		background.addEventListener(updateDataFromBackgroundEventName, onDataFromBackground);
	}
}

// Cross-thread function registry (project plan, Phase 6 — worklet
// substitute). The common worklet use case (a gesture/tap handler running
// on the thread it's authored on) needs NONE of this — it's already just an
// ordinary function in main-thread.ts. This is only for the remaining case:
// background-owned code needs to trigger a main-thread action outside the
// normal render/data cycle. Equal *capability* to upstream ReactLynx's own
// runOnMainThread/runOnBackground (both are async serialized RPC under the
// hood there too) — worse *ergonomics* only, since there's no compiler to
// extract an inline closure; handlers must be named and pre-registered on
// the thread they run on. Listener setup is lazy (on first use), not
// module-top-level, so importing this module never assumes a particular
// thread is active yet.
const mainThreadHandlers = new Map();
const pendingBackgroundCalls = new Map();
let nextCallId = 1;
let crossThreadCallsReady = false;

function ensureCrossThreadCalls() {
	if (crossThreadCallsReady) return;
	crossThreadCallsReady = true;
	const background = lynx.getJSContext();

	background.addEventListener(callMainThreadEventName, (event) => {
		const { callId, key, args } = event.data;
		const fn = mainThreadHandlers.get(key);
		let result;
		let error;
		try {
			result = fn ? fn(...args) : undefined;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		background.dispatchEvent({ type: callMainThreadResultEventName, data: { callId, result, error } });
	});

	background.addEventListener(callBackgroundResultEventName, (event) => {
		const { callId, result, error } = event.data;
		const pending = pendingBackgroundCalls.get(callId);
		if (pending == null) return;
		pendingBackgroundCalls.delete(callId);
		if (error != null) pending.reject(new Error(error));
		else pending.resolve(result);
	});
}

/** Registers a handler background.runOnMainThread(key, ...) can call by name. */
export function registerHandler(key, fn) {
	ensureCrossThreadCalls();
	mainThreadHandlers.set(key, fn);
}

/** Calls a handler background.js registered via registerHandler(key, fn), by name. Args must be JSON-serializable. */
export function runOnBackground(key, ...args) {
	ensureCrossThreadCalls();
	return new Promise((resolve, reject) => {
		const callId = nextCallId++;
		pendingBackgroundCalls.set(callId, { resolve, reject });
		lynx.getJSContext().dispatchEvent({ type: callBackgroundEventName, data: { callId, key, args } });
	});
}
