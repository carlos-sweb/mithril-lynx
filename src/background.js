// src/background.js
//
// Entry point for the background (JS) thread — the ONLY thread that ever
// runs a component's view() or Mithril's diff (architecture decision
// §3.1 of the plan: one thread model, not three like v1 had).
//
// The redraw contract, precisely: `render(dom, vnodes, redraw)`'s third
// argument is what real Mithril calls automatically after any event
// (CONTRACT.md §e, `EventDict.handleEvent`) — that is the ENTIRE mechanism
// by which "a tap handler that mutates state repaints the screen" works,
// with no cooperation from app code. v1's bug was that the function on the
// other end of that call was sometimes undefined depending on load order;
// here it is `requestRender` — a plain closure, captured once, always the
// same reference, never looked up through a global.
//
// `requestRender` renders synchronously (it calls `performRender`) for every
// redraw except one kind: the automatic redraw after a HIGH-FREQUENCY event
// (`gesturemove`, `touchmove`, `scroll`). Those fire 60-120 times a second
// during a drag, and a synchronous render after each one means a full diff,
// commit and patch back to the main thread per sample. Instead, the handler
// still runs for every single event (every sample reaches app code, in
// order), but the render it asks for is coalesced into at most one per
// frame. Any other render — a tap, `gestureup`, `redraw()`, a promise
// handler's later redraw — renders immediately and turns a pending frame
// render into a no-op, so the final state is always painted in order.

import renderFactory from "mithril-runtime/render/render.js";
import { createLynxDocument } from "./fake-dom.js";
import { createVirtualBackend } from "./backends/virtual-backend.js";
import { createCommitController } from "./commit.js";
import { onEventFromMainThread, sendPatchToMainThread } from "./channel.js";
import { register as registerRedraw } from "./mount-redraw.js";

/** Event types whose automatic redraw is coalesced to one per frame. Only
 * add types that fire continuously during one interaction (every sample of
 * a drag/scroll): their handlers still run per event, but the screen only
 * catches up once per frame. Discrete events (tap, input, gestureup) must
 * stay out so they keep rendering synchronously. */
const HIGH_FREQUENCY_EVENTS = new Set(["gesturemove", "touchmove", "scroll"]);

/**
 * Runs `fn` on the next frame: `lynx.requestAnimationFrame` when available,
 * otherwise a ~16ms timer.
 * @param {() => void} fn - The callback to run.
 * @returns {void}
 */
function scheduleFrame(fn) {
	if (typeof lynx !== "undefined" && typeof lynx.requestAnimationFrame === "function") {
		lynx.requestAnimationFrame(fn);
	} else {
		setTimeout(fn, 16);
	}
}

/**
 * @param {object} options
 * @param {() => unknown} options.root - Returns the current top-level vnode
 *   (a fresh hyperscript tree). Called on every render pass, including the
 *   very first — there is no separate "mount" vnode.
 * @param {(ops: unknown[]) => void} [options.sendPatch] - Ships one commit's
 *   worth of ops across the thread boundary. Defaults to the real channel
 *   (channel.js, F0.1's decision) — tests override it to capture ops
 *   in-process instead.
 * @param {(handler: (event: {data: {id: number, type: string, payload?: object}}) => void) => void} [options.subscribeEvents] -
 *   Subscribes the forwarded-event router. Defaults to the real channel's
 *   `onEventFromMainThread` — tests override it to drive the router directly.
 * @returns {{redraw: () => void, document: import("./fake-dom.js").LynxDocument}} The redraw function and the app's fake document.
 */
export function renderApp({ root, sendPatch = sendPatchToMainThread, subscribeEvents = onEventFromMainThread }) {
	const backend = createVirtualBackend();
	const document = createLynxDocument(backend);
	const render = renderFactory();
	const commitController = createCommitController();

	/**
	 * Drains the backend's ops and sends them, if there are any.
	 * @returns {void}
	 */
	function flush() {
		const ops = backend.takeOps();
		if (ops) sendPatch(ops);
	}
	commitController.install(flush);

	// This is Mithril's actual redraw service pattern (the same shape as
	// upstream `mithril/api/mount-redraw.js`'s internal `run()`): the
	// "redraw" callback IS "call render() again", not "send a patch"
	// directly — flushing is a side effect of every render pass completing,
	// whether that pass was the first one, an auto-redraw after an event, a
	// manual `redraw()` call, or a hot-update re-render (see reload/*.js).
	/**
	 * Runs one full render pass and commits the resulting patch, synchronously.
	 * @returns {void}
	 */
	function performRender() {
		framePending = false;
		render(document, root(), requestRender);
		commitController.commit();
	}

	// True only while a high-frequency event's handler is running.
	let dispatchingHighFrequency = false;
	// True while a coalesced render is scheduled for the next frame. Any
	// render in between clears it, so the scheduled one becomes a no-op
	// instead of needing a cancel API.
	let framePending = false;

	/**
	 * Mithril's redraw callback: renders now, except after a high-frequency
	 * event, where it schedules at most one render for the next frame.
	 * @returns {void}
	 */
	function requestRender() {
		if (!dispatchingHighFrequency) {
			performRender();
			return;
		}
		if (framePending) return;
		framePending = true;
		scheduleFrame(() => {
			if (framePending) performRender();
		});
	}

	performRender();
	registerRedraw(performRender);

	// Wires every forwarded native event straight to the fake-dom node it
	// targets — `dispatchEvent` (fake-dom.js) then invokes Mithril's own
	// EventDict exactly as a real DOM would, and (per the contract at the
	// top of this file) `requestRender` auto-fires afterward if the
	// handler doesn't opt out. This is the ONLY consumer of
	// `onEventFromMainThread` — app code never touches the channel directly.
	subscribeEvents((event) => {
		const { id, type, payload } = event.data;
		const node = document.getNodeById(id);
		if (!node) return;
		dispatchingHighFrequency = HIGH_FREQUENCY_EVENTS.has(type);
		try {
			node.dispatchEvent({ type, currentTarget: node, preventDefault() {}, stopPropagation() {}, ...payload });
		} finally {
			dispatchingHighFrequency = false;
		}
	});

	return {
		redraw: performRender,
		/** Exposed for tests and for an app's `module.hot.accept` glue (see
		 * the demo app's background.ts) — never needed by the channel
		 * wiring above, which is already fully self-contained. */
		document,
	};
}
