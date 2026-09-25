// src/list-runtime.js
//
// Main-thread runtime for Lynx's native `<list>`, driven by apply-patch.js.
// Runs ONLY on the main thread.
//
// The model is the one @lynx-js/react adopted for its element-template
// runtime (runtime/lib/element-template/runtime/list/list.js): `<list-item>`s
// are ORDINARY elements of the app's tree — created, diffed and updated by
// the normal patch stream — and each keeps its own element subtree for its
// whole life. The list never renders anything inside a native callback:
//
//   - InsertBefore/RemoveChild ops whose parent is a list do NOT touch the
//     native tree. They only update the list's logical item order and record
//     what changed; at the end of the patch, `flushUpdates()` tells native
//     through `update-list-info` (insert/remove/update actions, each carrying
//     the item's platform info) and re-registers the callbacks.
//   - `componentAtIndex` (native asking for index N) attaches item N's
//     existing element under the list, before the next attached item, and
//     flushes it. `enqueueComponent` (item scrolled away) detaches it again.
//
// Only attached items have native UI views; detached ones are plain element
// trees. Content updates inside any item are ordinary ops.
//
// PAPI contract, per ReactLynx:
//   __CreateList(pageId, componentAtIndex, enqueueComponent, {}, componentAtIndexes)
//   __SetAttribute(list, "update-list-info", { insertAction, removeAction, updateAction })
//   __UpdateListCallbacks(list, componentAtIndex, enqueueComponent, componentAtIndexes)
//   componentAtIndex(list, listID, cellIndex, operationID, enableReuseNotification) -> sign
//   componentAtIndexes(list, listID, cellIndexes, operationIDs, enableReuseNotification, asyncFlush)
//   enqueueComponent(list, listID, sign)

import { LIST_ITEM_PLATFORM_ATTRIBUTES } from "./list-attributes.js";

const PLATFORM_KEYS = new Set(LIST_ITEM_PLATFORM_ATTRIBUTES);

/**
 * Whether an attribute name is part of a list item's platform info.
 * @param {string} name - Attribute name.
 * @returns {boolean}
 */
export function isListItemPlatformAttribute(name) {
	return PLATFORM_KEYS.has(name);
}

/**
 * Shallow equality for two platform-info objects (their values are
 * primitives, as documented for every catalogued list-item attribute).
 * @param {Object<string, *>} a - First info.
 * @param {Object<string, *>} b - Second info.
 * @returns {boolean}
 */
function sameInfo(a, b) {
	const aKeys = Object.keys(a);
	if (aKeys.length !== Object.keys(b).length) return false;
	for (const key of aKeys) if (a[key] !== b[key]) return false;
	return true;
}

/**
 * The item's native `type`: its reuse pool. `reuse-identifier` when set,
 * like ReactLynx; otherwise one shared pool.
 * @param {{info: Object<string, *>}} item - The item record.
 * @returns {string}
 */
function typeOf(item) {
	const reuse = item.info["reuse-identifier"];
	return reuse != null ? String(reuse) : "list-item";
}

/**
 * Creates one native list and the state behind it.
 * @param {number} pageId - The page's unique id.
 * @returns {{handle: *, insert: (id: number, handle: *, info: Object, refId: number) => void, remove: (id: number) => void, has: (id: number) => boolean, updateInfo: (id: number, info: Object) => void, setUpdateAnimation: (value: *) => void, flushUpdates: () => void, detachRemoved: () => boolean, destroy: () => void}}
 */
export function createListRuntime(pageId) {
	/** @type {Array<{id: number, handle: *, info: Object<string, *>, attached: boolean, needsAttachMove: boolean, skipNextEnqueue: boolean}>} */
	let items = [];
	const itemsById = new Map();
	const itemsBySign = new Map();
	let hasAttachedMoves = false;
	let destroyed = false;
	// On-screen items removed by the current patch, detached only after the
	// patch's flush (see remove()).
	let removedAttached = [];
	// Mirrors the list's `update-animation` attribute (see remove()).
	let animatesUpdates = false;

	/**
	 * Records the list's `update-animation` attribute.
	 * @param {*} value - The attribute value.
	 * @returns {void}
	 */
	function setUpdateAnimation(value) {
		animatesUpdates = value === "default";
		if (animatesUpdates && typeof console !== "undefined") {
			console.warn(
				"[mithril-lynx] list: update-animation=\"default\" is not fully supported yet — removed items stay " +
					"attached to the list element (detaching them while native animates crashes Lynx). " +
					"See UPDATE_ANIMATION_GAP.md in mithril-lynx.",
			);
		}
	}
	// Set while a patch is changing this list: the item order and infos as
	// they were BEFORE the patch, plus what was inserted/removed since.
	let pending = null;

	/**
	 * Starts recording changes for the current patch, if not already.
	 * @returns {{beforeItems: Array<{id: number, info: Object}>, beforeIndexById: Map<number, number>, insertIds: Set<number>, removeIds: Set<number>}}
	 */
	function markPending() {
		if (pending == null) {
			const beforeItems = items.map((item) => ({ id: item.id, info: Object.assign({}, item.info) }));
			const beforeIndexById = new Map();
			beforeItems.forEach((item, index) => beforeIndexById.set(item.id, index));
			pending = { beforeItems, beforeIndexById, insertIds: new Set(), removeIds: new Set() };
		}
		return pending;
	}

	/**
	 * Index of an item in the current order.
	 * @param {number} id - Item id.
	 * @returns {number} The index, or -1.
	 */
	function indexOf(id) {
		for (let i = 0; i < items.length; i++) if (items[i].id === id) return i;
		return -1;
	}

	/**
	 * Inserts (or moves) an item before `refId` (-1 = at the end).
	 * @param {number} id - Item id.
	 * @param {*} handle - The item's `list-item` element.
	 * @param {Object<string, *>} info - Its current platform info.
	 * @param {number} refId - Id of the item to insert before, or -1.
	 * @returns {void}
	 */
	function insert(id, handle, info, refId) {
		const p = markPending();
		let item = itemsById.get(id);
		if (item != null) {
			// A move: Mithril re-inserted an item that is already in the list.
			// Native sees it as remove(old index) + insert(new index), like
			// ReactLynx; an attached one is re-placed on the next callback.
			items.splice(indexOf(id), 1);
			if (p.beforeIndexById.has(id)) p.removeIds.add(id);
			if (item.attached) {
				item.needsAttachMove = true;
				hasAttachedMoves = true;
			}
		} else {
			item = { id, handle, info: Object.assign({}, info), attached: false, needsAttachMove: false, skipNextEnqueue: false };
			itemsById.set(id, item);
		}
		const refIndex = refId === -1 ? -1 : indexOf(refId);
		if (refIndex === -1) items.push(item);
		else items.splice(refIndex, 0, item);
		p.insertIds.add(id);
	}

	/**
	 * Removes an item from the list's data. An item that is on screen is
	 * detached from the list element only AFTER native has processed this
	 * patch's `removeAction` (see detachRemoved()). Verified on a real device
	 * (Android, Lynx Go):
	 *   - detaching it here, before `update-list-info` is flushed, makes
	 *     native fail to find the item's holder and crash (SIGSEGV after
	 *     "[List] Fail to erase item holder");
	 *   - never detaching it renders fine (native drops its cell) but leaves
	 *     its element as an orphan child of the list, growing with every
	 *     removal — native never calls `enqueueComponent` for removed items;
	 *   - detaching it after the flush is clean, EXCEPT while an
	 *     `update-animation` is running on the list: native animates the
	 *     removed cell and crashes when the animation ends if its element is
	 *     gone. So with `update-animation="default"` removed items are left
	 *     attached (see setUpdateAnimation()).
	 * @param {number} id - Item id.
	 * @returns {void}
	 */
	function remove(id) {
		const item = itemsById.get(id);
		if (item == null) return;
		const p = markPending();
		items.splice(indexOf(id), 1);
		itemsById.delete(id);
		if (p.beforeIndexById.has(id)) p.removeIds.add(id);
		p.insertIds.delete(id);
		if (item.attached) removedAttached.push(item);
		else forgetSigns(item);
	}

	/**
	 * Drops every sign that maps to `item`.
	 * @param {Object} item - The item record.
	 * @returns {void}
	 */
	function forgetSigns(item) {
		for (const [sign, bound] of itemsBySign) if (bound === item) itemsBySign.delete(sign);
	}

	/**
	 * Detaches the on-screen items removed by the last patch. Must run after
	 * that patch's `update-list-info` has been flushed to native.
	 * @returns {boolean} Whether anything was detached (and needs a flush).
	 */
	function detachRemoved() {
		if (removedAttached.length === 0) return false;
		const detached = removedAttached;
		removedAttached = [];
		let any = false;
		for (const item of detached) {
			forgetSigns(item);
			if (!item.attached || destroyed || animatesUpdates) continue;
			__RemoveElement(handle, item.handle);
			item.attached = false;
			any = true;
		}
		return any;
	}

	/**
	 * Records a platform-info change on an item already in the list.
	 * @param {number} id - Item id.
	 * @param {Object<string, *>} info - The new info.
	 * @returns {void}
	 */
	function updateInfo(id, info) {
		const item = itemsById.get(id);
		if (item == null) return;
		markPending();
		item.info = Object.assign({}, info);
	}

	/**
	 * Sends this patch's changes to native, if any. Must run before the
	 * patch's `__FlushElementTree()`.
	 * @returns {void}
	 */
	function flushUpdates() {
		if (pending == null || destroyed) {
			pending = null;
			return;
		}
		const { beforeItems, beforeIndexById, insertIds, removeIds } = pending;
		pending = null;
		const insertAction = [];
		const removeAction = [];
		const updateAction = [];
		beforeItems.forEach((item, index) => {
			if (removeIds.has(item.id)) removeAction.push(index);
		});
		items.forEach((item, index) => {
			if (insertIds.has(item.id)) {
				insertAction.push(Object.assign({ position: index, type: typeOf(item) }, item.info));
				return;
			}
			const before = beforeItems[beforeIndexById.get(item.id)];
			if (!sameInfo(before.info, item.info)) {
				updateAction.push(Object.assign({}, item.info, { from: index, to: index, type: typeOf(item), flush: false }));
			}
		});
		if (insertAction.length === 0 && removeAction.length === 0 && updateAction.length === 0) return;
		__SetAttribute(handle, "update-list-info", { insertAction, removeAction, updateAction });
		__UpdateListCallbacks(handle, componentAtIndex, enqueueComponent, componentAtIndexes);
	}

	/**
	 * Re-places attached items that moved, walking from the end so each one
	 * lands before its already-placed successor. Like ReactLynx, the move
	 * makes native enqueue the item once more, which `skipNextEnqueue` absorbs.
	 * @returns {void}
	 */
	function moveAttachedItemsIntoFinalOrder() {
		if (!hasAttachedMoves) return;
		let reference = null;
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i];
			if (!item.attached) {
				item.needsAttachMove = false;
				continue;
			}
			if (item.needsAttachMove) {
				if (reference != null) __InsertElementBefore(handle, item.handle, reference);
				else __AppendElement(handle, item.handle);
				item.needsAttachMove = false;
				item.skipNextEnqueue = true;
			}
			reference = item.handle;
		}
		hasAttachedMoves = false;
	}

	/**
	 * The first attached item after `cellIndex`, whose element a newly
	 * attached item must be inserted before: native lays cells out in tree
	 * order.
	 * @param {number} cellIndex - The index being attached.
	 * @returns {*} The next attached element, or `null`.
	 */
	function nextAttachedHandle(cellIndex) {
		for (let i = cellIndex + 1; i < items.length; i++) if (items[i].attached) return items[i].handle;
		return null;
	}

	/**
	 * Attaches item `cellIndex` and returns its sign.
	 * @param {number} listID - The list's unique id.
	 * @param {number} cellIndex - The requested index.
	 * @param {number} operationID - Native operation id.
	 * @param {boolean} batch - Whether this is part of `componentAtIndexes`.
	 * @param {boolean} [asyncFlush=false] - Batch only: flush this item asynchronously.
	 * @returns {number} The item element's unique id, or -1 for an unknown index.
	 */
	function attach(listID, cellIndex, operationID, batch, asyncFlush = false) {
		moveAttachedItemsIntoFinalOrder();
		const item = items[cellIndex];
		if (item == null) {
			if (typeof console !== "undefined") {
				console.error(`[mithril-lynx] list: componentAtIndex(${cellIndex}) is out of range (${items.length} items).`);
			}
			return -1;
		}
		if (!item.attached) {
			const reference = nextAttachedHandle(cellIndex);
			if (reference != null) __InsertElementBefore(handle, item.handle, reference);
			else __AppendElement(handle, item.handle);
			item.attached = true;
			item.needsAttachMove = false;
		}
		const sign = __GetElementUniqueID(item.handle);
		itemsBySign.set(sign, item);
		if (!batch) __FlushElementTree(item.handle, { triggerLayout: true, operationID, elementID: sign, listID });
		else if (asyncFlush) __FlushElementTree(item.handle, { asyncFlush: true });
		return sign;
	}

	/**
	 * Native callback: provides the item at one index.
	 * @param {*} _list - The list element.
	 * @param {number} listID - The list's unique id.
	 * @param {number} cellIndex - The requested index.
	 * @param {number} operationID - Native operation id.
	 * @returns {number} The item's sign, or -1.
	 */
	function componentAtIndex(_list, listID, cellIndex, operationID) {
		if (destroyed) return -1;
		return attach(listID, cellIndex, operationID, false);
	}

	/**
	 * Native callback: provides several items with one list flush.
	 * @param {*} _list - The list element.
	 * @param {number} listID - The list's unique id.
	 * @param {number[]} cellIndexes - The requested indexes.
	 * @param {number[]} operationIDs - Native operation ids, one per index.
	 * @param {boolean} [_enableReuseNotification] - Unused: items are never reused for other data.
	 * @param {boolean} [asyncFlush] - Flush each item asynchronously.
	 * @returns {void}
	 */
	function componentAtIndexes(_list, listID, cellIndexes, operationIDs, _enableReuseNotification, asyncFlush) {
		if (destroyed) return;
		const elementIDs = cellIndexes.map((cellIndex, i) => attach(listID, cellIndex, operationIDs[i], true, asyncFlush === true));
		__FlushElementTree(handle, { triggerLayout: true, operationIDs, elementIDs, listID });
	}

	/**
	 * Native callback: an item scrolled away; detach its element.
	 * @param {*} _list - The list element.
	 * @param {number} _listID - The list's unique id.
	 * @param {number} sign - The item's sign.
	 * @returns {void}
	 */
	function enqueueComponent(_list, _listID, sign) {
		if (destroyed) return;
		const item = itemsBySign.get(sign);
		if (item == null) return;
		if (!item.attached) {
			itemsBySign.delete(sign);
			return;
		}
		if (item.skipNextEnqueue) {
			item.skipNextEnqueue = false;
			return;
		}
		__RemoveElement(handle, item.handle);
		item.attached = false;
		item.needsAttachMove = false;
		itemsBySign.delete(sign);
	}

	/**
	 * Neutralizes the native callbacks and drops all state, like ReactLynx's
	 * `snapshotDestroyList`. Safe to call more than once.
	 * @returns {void}
	 */
	function destroy() {
		if (destroyed) return;
		destroyed = true;
		__UpdateListCallbacks(handle, () => -1, () => {}, () => {});
		items = [];
		itemsById.clear();
		itemsBySign.clear();
		removedAttached = [];
		pending = null;
	}

	const handle = __CreateList(pageId, componentAtIndex, enqueueComponent, {}, componentAtIndexes);

	return {
		handle,
		insert,
		remove,
		updateInfo,
		setUpdateAnimation,
		/**
		 * @param {number} id - Item id.
		 * @returns {boolean} Whether the item is in this list.
		 */
		has: (id) => itemsById.has(id),
		flushUpdates,
		detachRemoved,
		destroy,
	};
}
