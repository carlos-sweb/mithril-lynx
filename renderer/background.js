// renderer/background.js
//
// "Renderer mode" (project plan, Phase 4): runs Mithril's UNMODIFIED diff
// algorithm on the background thread against a VirtualNodeWrapper tree
// (internal/virtual-node.js) instead of a real Element PAPI tree. Every
// mutation the diff makes is recorded as a serializable op; ops accumulated
// during one render/redraw pass are flushed as a single batch to the main
// thread, which replays them against a real LynxNodeWrapper tree (see
// renderer/main-thread.js's applyPatch()).
//
// This reuses the shim's OWN render()/redraw() convenience API unmodified —
// the algorithm never knows it's talking to a virtual tree, because it only
// ever calls generic dom.* methods (see ../CONTRACT.md). Note: render(), not
// renderToPage() — renderToPage() expects a RAW native page handle and calls
// __GetElementUniqueID() on it internally; render() takes an
// already-constructed wrapper directly, which is what the virtual root is.

import shim from "../src/lynx-mithril-shim.js";
import { createVirtualDocument } from "../internal/virtual-node.js";
import { rendererEventEventName, rendererPatchEventName } from "../internal/constants.js";

// A real app calls renderApp() exactly once, establishing this state for the
// lifetime of the app; redraw() operates on whatever the latest renderApp()
// call set up. Kept in module scope (rather than passed around) only because
// redraw() is a separate export with no other way to reach it — NOT shared
// across independent virtual trees the way a naively module-level
// styleProxies/vid-counter would be (createVirtualDocument() is called AFRESH
// inside renderApp(), so each call gets its own independent document, vid
// counter, and style-proxy registry).
let opLog = [];
let flushStyleProxies = () => {};

/**
 * Renders `root()` once against the virtual tree and sends the initial
 * patch. Call exactly once, at background.ts's top level (mirrors
 * setupApp()'s root() contract in data-channel mode: subsequent updates
 * flow through redraw(), which re-invokes the component's view(), not
 * root() again).
 */
export function renderApp(options) {
	const { root } = options;
	opLog = [];
	// vid -> VirtualNodeWrapper, so forwarded main-thread events (addressed by
	// vid) can be dispatched to the right node's listener.
	const nodesByVid = new Map();

	const virtualDocument = createVirtualDocument(
		(op) => opLog.push(op),
		(wrapper) => nodesByVid.set(wrapper._vid, wrapper),
	);
	flushStyleProxies = virtualDocument.flushStyleProxies;

	const rootWrapper = virtualDocument.createRootWrapper();

	shim.render(rootWrapper, root());
	flush();

	lynx.getCoreContext().addEventListener(rendererEventEventName, (event) => {
		const { vid, type, payload } = event.data;
		const node = nodesByVid.get(vid);
		if (node == null) return;
		node.dispatchEvent({
			type,
			currentTarget: node,
			preventDefault() {},
			stopPropagation() {},
			...payload,
		});
	});
}

function flush() {
	flushStyleProxies();
	if (opLog.length === 0) return;
	const ops = opLog;
	opLog = [];
	lynx.getCoreContext().dispatchEvent({ type: rendererPatchEventName, data: ops });
}

/** Re-invokes the app's view() and flushes the resulting patch. Call this — not shim.redraw() directly — after mutating state in an event handler. */
export function redraw() {
	shim.redraw();
	flush();
}
