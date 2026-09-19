// src/list-cell.js
//
// Runs ONLY on the background thread — the counterpart to list-support.js's
// main-thread half. Turns one `renderItem(item, index)` call into a
// self-contained set of construction ops, using the app's OWN document/
// backend/render (the same ones background.js already created for the rest
// of the tree) — never a separate, isolated render pipeline. That's the
// whole point: the item's real fake-dom nodes end up registered in the same
// `document._nodesById` map as everything else in the app, so a forwarded
// native event for one of them dispatches through `onEventFromMainThread`
// exactly like any other element's event already does. No extra reporting
// convention needed.
//
// The main thread never calls renderItem() itself — see list-support.js.

import { Op, forEachOp } from "./patch-protocol.js";

function typeKeyOf(vnode) {
	return typeof vnode.tag === "string" ? vnode.tag : (vnode.tag && vnode.tag.name) || "default";
}

/** The real handle ids inserted directly under `containerId` — what a
 * recycled cell on the main thread needs to remove before it can attach a
 * different item's content into the same native wrapper (see
 * list-support.js's clearWrapperChildren). Scanning the ops after the fact,
 * instead of tracking during render, keeps this file from needing any
 * backend-internal access beyond `captureOps` itself. */
function findTopLevelChildIds(ops, containerId) {
	const ids = [];
	forEachOp(ops, (opcode, args) => {
		if (opcode === Op.InsertBefore && args[0] === containerId) ids.push(args[1]);
	});
	return ids;
}

/**
 * @param {import("./fake-dom.js").LynxDocument} document - the app's own
 *   document (e.g. `vnode.dom.ownerDocument` from inside a component) — NOT
 *   a separate one. Sharing it is what keeps a list cell's ids in the same
 *   `_nodesById` space as the rest of the app.
 * @param {(dom: object, vnodes: unknown[], redraw: () => void) => void} render
 *   - a `mithril-runtime/render/render.js` instance. Callers typically keep
 *   one shared instance per `<List>` (see mithril-lynx-ui's list.js), not
 *   one per cell — render() is designed to manage multiple independent
 *   containers safely.
 * @param {() => void} redraw - forwarded as render()'s own redraw callback,
 *   so a `ontap` (etc.) handler inside the rendered cell triggers a REAL
 *   app-wide redraw afterward, exactly like any other event in the app —
 *   see mithril-lynx/mount-redraw's `redraw()`.
 * @param {(item: unknown, index: number) => unknown} renderItem
 * @param {unknown} item
 * @param {number} index
 * @returns {{ typeKey: string, containerId: number, ops: unknown[], rootChildIds: number[] }}
 */
export function renderListCell(document, render, redraw, renderItem, item, index) {
	// An ordinary element in the SAME document, never inserted into the
	// visible tree (no `appendChild`/`insertBefore` call targets it) — its
	// own `Op.CreateElement` never gets captured below since it's created
	// OUTSIDE the capture, before there's anything to record; only what
	// render() does INSIDE it is captured. The main thread's list-support.js
	// treats `containerId` as an alias for whatever real native wrapper it
	// creates for this cell, the same way apply-patch.js's top-level applier
	// treats id 0 as an alias for the real page element.
	const container = document.createElement("list-cell-root");
	const vnode = renderItem(item, index);
	const typeKey = typeKeyOf(vnode);

	const ops = document.captureOps(() => {
		render(container, [vnode], redraw);
	});

	return { typeKey, containerId: container._id, ops, rootChildIds: findTopLevelChildIds(ops, container._id) };
}
