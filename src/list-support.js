// src/list-support.js
//
// Runs ONLY on the main thread — imported from an app's own main-thread.ts,
// alongside setupRenderer() (see docs/native-papi/papi-06-virtualized-lists.md
// in mithril-lynx-ui for the full design). Registers the render function(s)
// a native virtualized list needs: the function itself can never cross the
// background-thread/main-thread boundary (real main and background threads
// are separate JS engine instances — no shared closures, only serializable
// messages), so an app registers it here by a string key instead, and
// mithril-lynx-ui's List component references that same key from
// background.ts.
//
// The native list contract this wires up (__CreateList/__UpdateListCallbacks,
// the synchronous componentAtIndex/enqueueComponent pair, recycling cells by
// a type key) is unchanged from mithril-lynx v1's own list.js — that part
// was already device-verified. What's different: each cell is rendered by a
// REAL, self-contained render pass entirely on THIS thread (the exact same
// pieces background.js uses for the app's own tree — mithril-runtime's real
// render(), fake-dom.js, a virtual backend — just applied to itself
// immediately via a nested patch applier, instead of crossing a channel).
// componentAtIndex's native contract is synchronous; a cross-thread round
// trip could never satisfy that, so this is the only architecture that can.
//
// KNOWN GAP, not solved by this file: an event handler (e.g. `ontap`)
// inside a renderItem()-produced vnode fires entirely on this thread, with
// no way back to the app's own state on the background thread — there is
// no background-thread fake-dom node for list cell content to dispatch
// through (unlike every other element in the app, which the background
// thread DOES know about). Reaching back into app state from inside a list
// cell needs a deliberate reporting convention, not built here yet.

import renderFactory from "mithril-runtime/render/render.js";
import { createLynxDocument } from "./fake-dom.js";
import { createVirtualBackend } from "./backends/virtual-backend.js";

const renderers = new Map();

/** Call once per list your app uses, from main-thread.ts — see this file's
 * own header for why the render function itself can't just be imported
 * from background.ts and passed across directly. */
export function registerListRenderer(key, renderItem) {
	renderers.set(key, renderItem);
}

function typeKeyOf(vnode) {
	return typeof vnode.tag === "string" ? vnode.tag : (vnode.tag && vnode.tag.name) || "default";
}

function makeCell(pageId, wrapperHandle, createPatchApplier) {
	const backend = createVirtualBackend();
	const document = createLynxDocument(backend);
	const render = renderFactory();
	const applier = createPatchApplier(pageId);
	applier.registerPageRoot(wrapperHandle);
	return { wrapper: wrapperHandle, backend, document, render, applier, typeKey: null };
}

/** Re-renders `vnode` into `cell`'s own persistent fake-dom document —
 * Mithril's own diff (real, not simulated) computes the minimal update
 * against whatever this cell showed before, exactly like a normal redraw,
 * so recycling a cell for a different item never needs a manual "clear
 * old content first" step. */
function renderCellVnode(cell, vnode) {
	cell.render(cell.document, [vnode], () => {});
	const ops = cell.backend.takeOps();
	if (ops) cell.applier.applyPatch(ops);
}

/**
 * @param {number} pageId
 * @param {string} rendererKey
 * @param {(pageId: number, options?: {onEvent?: Function}) => object} createPatchApplier
 *   - passed in rather than imported, to avoid a circular import with
 *   apply-patch.js (the only caller).
 * @param {Function} [onEvent] - forwarded into each cell's own patch
 *   applier, same as the top-level one — see this file's own "known gap"
 *   note above for what this does NOT yet solve.
 */
export function createNativeList(pageId, rendererKey, scrollOrientation, listType, spanCount, createPatchApplier, onEvent) {
	const renderItem = renderers.get(rendererKey);
	if (renderItem == null) {
		throw new Error(
			`[mithril-lynx] no list renderer registered for "${rendererKey}" — call registerListRenderer("${rendererKey}", ...) from main-thread.ts.`,
		);
	}

	let items = [];
	let count = 0;
	const recycleMap = new Map(); // typeKey -> Map<sign, cell>
	const signMap = new Map(); // sign -> cell

	function bindFreshItem(listHandle, listId, cellIndex, opId, vnode, typeKey) {
		const wrapperHandle = __CreateElement("list-item", pageId, {});
		__SetAttribute(wrapperHandle, "item-key", String(cellIndex));
		__AppendElement(listHandle, wrapperHandle);

		const cell = makeCell(pageId, wrapperHandle, (pid) => createPatchApplier(pid, { onEvent }));
		cell.typeKey = typeKey;
		renderCellVnode(cell, vnode);

		const sign = __GetElementUniqueID(wrapperHandle);
		signMap.set(sign, cell);
		__FlushElementTree(wrapperHandle, { triggerLayout: true, operationID: opId, elementID: sign, listID: listId });
		return sign;
	}

	function bindRecycledItem(listId, cellIndex, opId, vnode, typeKey, pool) {
		const [sign, cell] = pool.entries().next().value;
		pool.delete(sign);
		__SetAttribute(cell.wrapper, "item-key", String(cellIndex));
		cell.typeKey = typeKey;
		renderCellVnode(cell, vnode);
		signMap.set(sign, cell);
		__FlushElementTree(cell.wrapper, { triggerLayout: true, operationID: opId, elementID: sign, listID: listId });
		return sign;
	}

	function componentAtIndex(listHandle, listId, cellIndex, opId) {
		if (cellIndex < 0 || cellIndex >= count) {
			throw new Error(`[mithril-lynx] list: cellIndex ${cellIndex} out of range (itemCount=${count})`);
		}
		const vnode = renderItem(items[cellIndex], cellIndex);
		const typeKey = typeKeyOf(vnode);
		const pool = recycleMap.get(typeKey);
		if (pool && pool.size > 0) return bindRecycledItem(listId, cellIndex, opId, vnode, typeKey, pool);
		return bindFreshItem(listHandle, listId, cellIndex, opId, vnode, typeKey);
	}

	function enqueueComponent(_listHandle, _listId, sign) {
		const cell = signMap.get(sign);
		if (cell == null) return;
		signMap.delete(sign);
		if (!recycleMap.has(cell.typeKey)) recycleMap.set(cell.typeKey, new Map());
		recycleMap.get(cell.typeKey).set(sign, cell);
	}

	function sendListInfo(listHandle, listId, insertAction, removeAction, updateAction) {
		__SetAttribute(listHandle, "update-list-info", { insertAction, removeAction, updateAction });
		__UpdateListCallbacks(listHandle, componentAtIndex, enqueueComponent);
	}

	const listHandle = __CreateList(pageId, componentAtIndex, enqueueComponent, {});
	const listId = __GetElementUniqueID(listHandle);
	__SetAttribute(listHandle, "scroll-orientation", scrollOrientation);
	__SetAttribute(listHandle, "list-type", listType);
	__SetAttribute(listHandle, "span-count", String(spanCount));

	listHandle.__setItems = (nextItems) => {
		const nextCount = nextItems.length;
		items = nextItems;
		if (nextCount === count) return;
		if (nextCount > count) {
			sendListInfo(
				listHandle,
				listId,
				Array.from({ length: nextCount - count }, (_, i) => ({ position: count + i, type: "cell", "item-key": String(count + i) })),
				[],
				[],
			);
		} else {
			sendListInfo(listHandle, listId, [], Array.from({ length: count - nextCount }, (_, i) => nextCount + i), []);
		}
		count = nextCount;
	};

	return listHandle;
}
