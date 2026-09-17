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
// here it is `performRender` — a plain closure, captured once, always the
// same reference, never looked up through a global.

import renderFactory from "mithril/render/render.js";
import { createLynxDocument } from "./fake-dom.js";
import { createVirtualBackend } from "./backends/virtual-backend.js";
import { createCommitController } from "./commit.js";

/**
 * @param {object} options
 * @param {() => unknown} options.root - Returns the current top-level vnode
 *   (a fresh hyperscript tree). Called on every render pass, including the
 *   very first — there is no separate "mount" vnode.
 * @param {(ops: unknown[]) => void} options.sendPatch - Ships one commit's
 *   worth of ops across the thread boundary. See channel.js for the actual
 *   transport (F0.1's decision).
 */
export function renderApp({ root, sendPatch }) {
	const backend = createVirtualBackend();
	const document = createLynxDocument(backend);
	const render = renderFactory();
	const commitController = createCommitController();

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
	function performRender() {
		render(document, root(), performRender);
		commitController.commit();
	}

	performRender();

	return {
		redraw: performRender,
		/** Exposed for the background-side event router (see channel.js) —
		 * forwarded native events are dispatched to the fake-dom node with
		 * this id, which invokes Mithril's own EventDict and (per the
		 * contract above) auto-redraws if the handler doesn't opt out. */
		document,
	};
}
