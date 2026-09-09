// background.js
//
// Cross-thread "data-channel mode" adapter for the background thread (see
// the project plan, Phase 3). Ports
// lynx-examples/examples/vanilla/src/common/background/{setup,data,event}.ts
// into a single module — this side is framework-agnostic (Mithril never
// renders on the background thread in data-channel mode), so nothing here
// depends on the shim.
//
// A single mutable data store is diffed against its last-synced snapshot on
// every setData() call and only the changed keys are pushed to the main
// thread. Data received FROM the main thread is never echoed back (the
// reference implementation does, on every update after the first — a
// pure round-trip echo that's wasteful, and directly visible as a redundant
// extra Mithril redraw in this port, so it isn't reproduced here).

import {
	callBackgroundEventName,
	callBackgroundResultEventName,
	callMainThreadEventName,
	callMainThreadResultEventName,
	destroyLifetimeEventName,
	dispatchEventToBackgroundEventName,
	updateDataFromBackgroundEventName,
	updateDataFromMainThreadEventName,
} from "./internal/constants.js";

const data = {};
let lastSyncedData = { ...data };
let handleBackgroundEvent;

export function getData() {
	return data;
}

export function setData(patch, options = {}) {
	const { shouldSyncToMainThread = true } = options;
	Object.assign(data, patch);
	if (!shouldSyncToMainThread) {
		lastSyncedData = { ...data };
		return;
	}
	sendToMainThread();
}

function sendToMainThread() {
	const patch = {};
	for (const [key, value] of Object.entries(data)) {
		if (value !== lastSyncedData[key]) patch[key] = value;
	}
	if (Object.keys(patch).length === 0) return;
	lastSyncedData = { ...data };
	lynx.getCoreContext().dispatchEvent({
		type: updateDataFromBackgroundEventName,
		data: patch,
	});
}

// handleEvent(handlerName, data) — called for every dispatchToBackground()
// call made from the main thread. Only one handler at a time; Phase 6 of the
// project plan generalizes this into a full string-keyed registry with
// call/return correlation.
export function setBackgroundEventHandler(handleEvent) {
	handleBackgroundEvent = handleEvent;
}

export function setupBackground() {
	const coreContext = lynx.getCoreContext();

	const onUpdateDataFromMainThread = (event) => {
		const incoming = event.data;
		if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return;
		// Never echo data back to the thread it just came from — only
		// background-initiated setData() calls (elsewhere in app code)
		// should sync to the main thread.
		setData(incoming, { shouldSyncToMainThread: false });
	};

	const onDispatchToBackground = (event) => {
		const payload = event.data;
		if (!payload || typeof payload.handlerName !== "string") return;
		handleBackgroundEvent?.(payload.handlerName, payload.data);
	};

	const cleanup = () => {
		coreContext.removeEventListener(updateDataFromMainThreadEventName, onUpdateDataFromMainThread);
		coreContext.removeEventListener(dispatchEventToBackgroundEventName, onDispatchToBackground);
		coreContext.removeEventListener(destroyLifetimeEventName, cleanup);
	};

	coreContext.addEventListener(updateDataFromMainThreadEventName, onUpdateDataFromMainThread);
	coreContext.addEventListener(dispatchEventToBackgroundEventName, onDispatchToBackground);
	coreContext.addEventListener(destroyLifetimeEventName, cleanup);
}

// Refs (project plan, Phase 5): the background thread has no direct native
// handle, so imperative calls go through Lynx's existing selector-query
// bridge (the same primitive ReactLynx's own background-thread refs
// ultimately bottom out on) rather than a new protocol.
export function createRef(selector) {
	return {
		invoke(method, params) {
			return new Promise((resolve, reject) => {
				lynx.createSelectorQuery()
					.select(selector)
					.invoke({
						method,
						params: params || {},
						success: (data) => resolve(data),
						fail: (data) => reject(data),
					})
					.exec();
			});
		},
	};
}

// Cross-thread function registry (project plan, Phase 6 — worklet
// substitute). See main-thread.js's registerHandler()/runOnBackground() for
// the full rationale; this is the mirror image for the reverse direction.
// Lazy setup on first use, same reasoning as main-thread.js.
const backgroundHandlers = new Map();
const pendingMainThreadCalls = new Map();
let nextCallId = 1;
let crossThreadCallsReady = false;

function ensureCrossThreadCalls() {
	if (crossThreadCallsReady) return;
	crossThreadCallsReady = true;
	const coreContext = lynx.getCoreContext();

	coreContext.addEventListener(callBackgroundEventName, (event) => {
		const { callId, key, args } = event.data;
		const fn = backgroundHandlers.get(key);
		let result;
		let error;
		try {
			result = fn ? fn(...args) : undefined;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		coreContext.dispatchEvent({ type: callBackgroundResultEventName, data: { callId, result, error } });
	});

	coreContext.addEventListener(callMainThreadResultEventName, (event) => {
		const { callId, result, error } = event.data;
		const pending = pendingMainThreadCalls.get(callId);
		if (pending == null) return;
		pendingMainThreadCalls.delete(callId);
		if (error != null) pending.reject(new Error(error));
		else pending.resolve(result);
	});
}

/** Registers a handler main-thread.js's runOnBackground(key, ...) can call by name. */
export function registerHandler(key, fn) {
	ensureCrossThreadCalls();
	backgroundHandlers.set(key, fn);
}

/** Calls a handler main-thread.js registered via registerHandler(key, fn), by name. Args must be JSON-serializable. */
export function runOnMainThread(key, ...args) {
	ensureCrossThreadCalls();
	return new Promise((resolve, reject) => {
		const callId = nextCallId++;
		pendingMainThreadCalls.set(callId, { resolve, reject });
		lynx.getCoreContext().dispatchEvent({ type: callMainThreadEventName, data: { callId, key, args } });
	});
}
