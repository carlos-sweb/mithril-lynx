// src/list-support.js
//
// Runs ONLY on the main thread — the counterpart to list-cell.js's
// background-thread half. Wires up the native list contract
// (__CreateList/__UpdateListCallbacks, the synchronous componentAtIndex/
// enqueueComponent pair, recycling cells by a type key) — unchanged from
// mithril-lynx v1's own device-verified list.js.
//
// What's different from v1, and from this file's own first version: a
// cell's content is never rendered here. `componentAtIndex` only replays
// ops the background thread already computed (list-cell.js), the same way
// apply-patch.js's own top-level applyPatch replays the app's own tree —
// this file has no dependency on mithril-runtime, fake-dom.js, or a virtual
// backend at all anymore, because it never runs a render pass of its own.
// componentAtIndex(itemCount) cost is therefore the cost of creating/
// updating real elements from an already-known op list, same as any other
// patch — not a render.
//
// Recycling a cell for a different item clears its real children (removed
// by the handle ids list-cell.js recorded — see clearWrapperChildren below)
// and replays the new item's ops fresh; this is a real teardown-and-rebuild
// of that cell's content, not a diff against what was there before. A real
// Mithril diff on recycle would need a persistent per-slot fake-dom
// document kept in sync with which native cell native actually chose to
// reuse — information only native has, on the main thread, which the
// background thread (where the diff would have to run) can't see without a
// round trip. Not implemented.

/**
 * Creates a native virtualized list on the main thread and wires its cell callbacks.
 * @param {number} pageId - The page's unique id.
 * @param {string} scrollOrientation - Scroll direction.
 * @param {string} listType - Native list layout type.
 * @param {number} spanCount - Number of columns/spans.
 * @param {Function} createPatchApplier - Factory for a per-cell patch applier (see apply-patch.js).
 * @param {(id: number, type: string, payload: unknown) => void} [onEvent] - Receives native events from cell content.
 * @returns {{handle: *, setCells: (nextCells: Array<{typeKey: string, containerId: number, ops: unknown[], rootChildIds: number[]}>) => void}} The list handle and the function that replaces its cells.
 */
export function createNativeList(pageId, scrollOrientation, listType, spanCount, createPatchApplier, onEvent) {
	let cells = []; // current cells, indexed by cellIndex — see patch-protocol.js's Op.SetListItems
	let count = 0;
	const signMap = new Map(); // sign -> { wrapperHandle, applier, rootChildIds, cellIndex, typeKey }
	const recycleMap = new Map(); // typeKey -> Map<sign, entry> (entries currently off-screen, available to reuse)

	/**
	 * Replays a cell's ops into a native wrapper element.
	 * @param {*} wrapperHandle - The native wrapper element.
	 * @param {{containerId: number, ops: unknown[]}} cell - The cell descriptor.
	 * @returns {{applyPatch: Function, getHandle: Function}} The applier used, kept to resolve child handles later.
	 */
	function replayCell(wrapperHandle, cell) {
		const applier = createPatchApplier(pageId, { onEvent, flush: false });
		applier.registerRoot(cell.containerId, wrapperHandle);
		applier.applyPatch(cell.ops);
		return applier;
	}

	/**
	 * Removes a cell's previously inserted top-level children from its wrapper.
	 * @param {{wrapperHandle: *, applier: {getHandle: Function}, rootChildIds: number[]}} entry - The attached cell entry.
	 * @returns {void}
	 */
	function clearWrapperChildren(entry) {
		for (const id of entry.rootChildIds) {
			const handle = entry.applier.getHandle(id);
			if (handle != null) __RemoveElement(entry.wrapperHandle, handle);
		}
	}

	/** The wrapper of the lowest currently-attached cellIndex greater than
	 * `cellIndex`, or null if none — the DOM position a cell at `cellIndex`
	 * needs to be inserted before to land in the right place. Native lays
	 * cells out in document-tree order, not by `item-key`, so a recycled
	 * wrapper that keeps its OLD tree position (this file's own first
	 * version never repositioned it at all) shows up out of order the
	 * moment it's reused for a different index — confirmed on real
	 * hardware via a scrambled child order after scrolling (item-keys
	 * 7,8,9,3,4,5,6). Same problem `@lynx-js/react`'s own
	 * `attachListItemAtIndex`/`findNextAttachedItem` solves for its
	 * Element Template list.
	 * @param {number} cellIndex - The index of the cell being positioned.
	 * @returns {*} The wrapper handle of the next attached cell, or `null`.
	 */
	function findNextAttachedWrapper(cellIndex) {
		let best = null;
		for (const entry of signMap.values()) {
			if (entry.cellIndex > cellIndex && (best == null || entry.cellIndex < best.cellIndex)) best = entry;
		}
		return best ? best.wrapperHandle : null;
	}

	/**
	 * Inserts a cell wrapper into the list at its correct tree position.
	 * @param {*} listHandle - The native list element.
	 * @param {*} wrapperHandle - The cell wrapper to insert.
	 * @param {number} cellIndex - The cell's index.
	 * @returns {void}
	 */
	function attachWrapper(listHandle, wrapperHandle, cellIndex) {
		const refHandle = findNextAttachedWrapper(cellIndex);
		if (refHandle != null) __InsertElementBefore(listHandle, wrapperHandle, refHandle);
		else __AppendElement(listHandle, wrapperHandle);
	}

	/**
	 * Creates a new wrapper for a cell and replays its ops.
	 * @param {*} listHandle - The native list element.
	 * @param {number} listId - The list's unique id.
	 * @param {number} cellIndex - The cell's index.
	 * @param {number} opId - Native operation id for the flush.
	 * @param {{typeKey: string, containerId: number, ops: unknown[], rootChildIds: number[]}} cell - The cell descriptor.
	 * @param {boolean} flush - Whether to flush this cell immediately.
	 * @returns {number} The wrapper's unique id (its sign).
	 */
	function bindFreshItem(listHandle, listId, cellIndex, opId, cell, flush) {
		const wrapperHandle = __CreateElement("list-item", pageId, {});
		__SetAttribute(wrapperHandle, "item-key", String(cellIndex));
		attachWrapper(listHandle, wrapperHandle, cellIndex);

		const applier = replayCell(wrapperHandle, cell);
		const sign = __GetElementUniqueID(wrapperHandle);
		signMap.set(sign, { wrapperHandle, applier, rootChildIds: cell.rootChildIds, cellIndex, typeKey: cell.typeKey });
		if (flush) __FlushElementTree(wrapperHandle, { triggerLayout: true, operationID: opId, elementID: sign, listID: listId });
		return sign;
	}

	/**
	 * Reuses an off-screen wrapper for a different cell: clears it, repositions it, and replays the new ops.
	 * @param {*} listHandle - The native list element.
	 * @param {number} listId - The list's unique id.
	 * @param {number} cellIndex - The cell's index.
	 * @param {number} opId - Native operation id for the flush.
	 * @param {{typeKey: string, containerId: number, ops: unknown[], rootChildIds: number[]}} cell - The cell descriptor.
	 * @param {Map<number, Object>} pool - Available entries of the same type.
	 * @param {boolean} flush - Whether to flush this cell immediately.
	 * @returns {number} The wrapper's unique id (its sign).
	 */
	function bindRecycledItem(listHandle, listId, cellIndex, opId, cell, pool, flush) {
		const [sign, entry] = pool.entries().next().value;
		pool.delete(sign);
		clearWrapperChildren(entry);
		__SetAttribute(entry.wrapperHandle, "item-key", String(cellIndex));
		attachWrapper(listHandle, entry.wrapperHandle, cellIndex);
		const applier = replayCell(entry.wrapperHandle, cell);
		entry.applier = applier;
		entry.rootChildIds = cell.rootChildIds;
		entry.cellIndex = cellIndex;
		signMap.set(sign, entry);
		if (flush) __FlushElementTree(entry.wrapperHandle, { triggerLayout: true, operationID: opId, elementID: sign, listID: listId });
		return sign;
	}

	/**
	 * Binds a cell, recycling a same-type wrapper when one is available.
	 * @param {*} listHandle - The native list element.
	 * @param {number} listId - The list's unique id.
	 * @param {number} cellIndex - The cell's index.
	 * @param {number} opId - Native operation id for the flush.
	 * @param {boolean} flush - Whether to flush this cell immediately.
	 * @returns {number} The wrapper's unique id (its sign).
	 * @throws {Error} If `cellIndex` is out of range.
	 */
	function bindCell(listHandle, listId, cellIndex, opId, flush) {
		if (cellIndex < 0 || cellIndex >= count) {
			throw new Error(`[mithril-lynx] list: cellIndex ${cellIndex} out of range (itemCount=${count})`);
		}
		const cell = cells[cellIndex];
		const pool = recycleMap.get(cell.typeKey);
		if (pool && pool.size > 0) return bindRecycledItem(listHandle, listId, cellIndex, opId, cell, pool, flush);
		return bindFreshItem(listHandle, listId, cellIndex, opId, cell, flush);
	}

	/**
	 * Native callback: provides the cell at one index.
	 * @param {*} listHandle - The native list element.
	 * @param {number} listId - The list's unique id.
	 * @param {number} cellIndex - The requested index.
	 * @param {number} opId - Native operation id.
	 * @returns {number} The wrapper's unique id (its sign).
	 */
	function componentAtIndex(listHandle, listId, cellIndex, opId) {
		return bindCell(listHandle, listId, cellIndex, opId, true);
	}

	/**
	 * The batched form of componentAtIndex — real native calls this (not a
	 * fallback: confirmed against `@lynx-js/react`'s own
	 * componentAtIndexFactory/attachListItemAtIndex, which always registers
	 * BOTH forms) for several cells at once, expecting exactly ONE
	 * `__FlushElementTree` covering all of them (`operationIDs`/`elementIDs`
	 * arrays), not one per cell — the real reason a native list's initial,
	 * simultaneously-visible cells need this at all.
	 * @param {*} listHandle - The native list element.
	 * @param {number} listId - The list's unique id.
	 * @param {number[]} cellIndexes - The requested indexes.
	 * @param {number[]} operationIDs - Native operation ids, one per index.
	 * @returns {void}
	 */
	function componentAtIndexes(listHandle, listId, cellIndexes, operationIDs) {
		const elementIDs = cellIndexes.map((cellIndex, i) => bindCell(listHandle, listId, cellIndex, operationIDs[i], false));
		__FlushElementTree(listHandle, { triggerLayout: true, operationIDs, elementIDs, listID: listId });
	}

	/**
	 * Native callback: a cell scrolled off-screen and becomes available for recycling.
	 * @param {*} _listHandle - Unused.
	 * @param {number} _listId - Unused.
	 * @param {number} sign - The wrapper's unique id.
	 * @returns {void}
	 */
	function enqueueComponent(_listHandle, _listId, sign) {
		const entry = signMap.get(sign);
		if (entry == null) return;
		signMap.delete(sign);
		if (!recycleMap.has(entry.typeKey)) recycleMap.set(entry.typeKey, new Map());
		recycleMap.get(entry.typeKey).set(sign, entry);
	}

	/**
	 * Tells the native list about inserted, removed and updated cells.
	 * @param {*} listHandle - The native list element.
	 * @param {number} listId - The list's unique id.
	 * @param {Array<Object>} insertAction - Inserted cell descriptors.
	 * @param {number[]} removeAction - Removed positions.
	 * @param {Array<Object>} updateAction - Updated cell descriptors.
	 * @returns {void}
	 */
	function sendListInfo(listHandle, listId, insertAction, removeAction, updateAction) {
		__SetAttribute(listHandle, "update-list-info", { insertAction, removeAction, updateAction });
		__UpdateListCallbacks(listHandle, componentAtIndex, enqueueComponent, componentAtIndexes);
	}

	const listHandle = __CreateList(pageId, componentAtIndex, enqueueComponent, {}, componentAtIndexes);
	const listId = __GetElementUniqueID(listHandle);
	__SetAttribute(listHandle, "scroll-orientation", scrollOrientation);
	__SetAttribute(listHandle, "list-type", listType);
	__SetAttribute(listHandle, "span-count", String(spanCount));

	// Re-flushes every currently-attached (on-screen) cell with its newest
	// ops — e.g. after a redraw triggered by a tap inside a cell, or any
	// other app state change that reaches this list's items. Unconditional,
	// same as List's own onupdate already unconditionally resends the whole
	// `items` array on every relevant redraw (see mithril-lynx-ui's
	// list/list.js) — a real "did this cell's content actually change"
	// check would need to compare `ops` arrays, not implemented yet. Cells
	// that aren't attached right now just pick up their new content next
	// time componentAtIndex asks for that index.
	/**
	 * @param {Array<{typeKey: string, containerId: number, ops: unknown[], rootChildIds: number[]}>} nextCells - The new cells.
	 * @returns {void}
	 */
	function refreshAttachedCells(nextCells) {
		for (const [sign, entry] of signMap) {
			const nextCell = nextCells[entry.cellIndex];
			clearWrapperChildren(entry);
			entry.applier = replayCell(entry.wrapperHandle, nextCell);
			entry.rootChildIds = nextCell.rootChildIds;
			entry.typeKey = nextCell.typeKey;
			signMap.set(sign, entry);
			__FlushElementTree(entry.wrapperHandle, { triggerLayout: false });
		}
	}

	/**
	 * Replaces the list's cells, refreshing attached ones and notifying native of count changes.
	 * @param {Array<{typeKey: string, containerId: number, ops: unknown[], rootChildIds: number[]}>} nextCells - The new cells.
	 * @returns {void}
	 */
	function setCells(nextCells) {
		const nextCount = nextCells.length;
		refreshAttachedCells(nextCells);
		cells = nextCells;
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
	}

	// Returned separately, not as a property stuck onto `listHandle` itself:
	// confirmed on real hardware (unlike @lynx-js/testing-environment's
	// simulated PAPI) that a native list's own returned handle does not
	// reliably hold a custom property across calls — assigning one there
	// and reading it back later from apply-patch.js's Op.SetListItems case
	// threw "TypeError: not a function" on the very first SetListItems, even
	// with zero items. apply-patch.js keeps `setCells` in its own map
	// instead, keyed the same way `handles` already is.
	return { handle: listHandle, setCells };
}
