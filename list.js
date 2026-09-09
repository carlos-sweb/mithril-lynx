// list.js
//
// List virtualization/recycling (project plan, Phase 8, Tier 2), main-thread
// only. __CreateList's componentAtIndex/enqueueComponent callbacks are a
// native-driven recycler: native owns scroll position and cell lifecycle,
// calling back into JS to fetch or recycle a cell's content by TYPE
// (matching RecyclerView/UICollectionView semantics), not a JS-side
// windowing calculation.
//
// The sign/recycle map design and the exact __FlushElementTree({triggerLayout,
// operationID, elementID, listID}) call shape are ported from
// @lynx-js/react's OWN shipped runtime/lib/snapshot/list/list.js — real,
// proven code, not guesswork (unlike gesture.js's callback-shape question,
// this part IS verified against a real implementation). What list.js narrows
// down for v1, deliberately:
//   - No deferred list items (ReactLynx's `defer`/`isReady` promise dance —
//     ties into a whole separate lifecycle-event protocol not otherwise
//     needed here).
//   - No componentAtIndexes batching — native's single-cell componentAtIndex
//     callback only.
//   - No independent per-item redraw after the initial bind/recycle — a list
//     item's content is (re)computed fresh from renderItem(index) every time
//     native calls componentAtIndex for it (on scroll-driven reuse), not
//     whenever the app's own state changes. An app wanting a currently-bound
//     visible item to reflect a data change needs its OWN mechanism to ask
//     native to re-request that cell; list.js does not provide one in v1.
//
// This is an imperative escape hatch, like element.js/gesture.js — call it
// from oncreate(vnode) and attach the result yourself
// (parentNode.appendChild(list)), rather than mounting it through m().
// Tier 1 (no code here at all — just m("list", ...)/m("list-item", ...) as
// ordinary tags through the existing shim, relying on its already-tested
// keyed/LIS diff) covers the common case and should be preferred unless the
// app specifically needs native-driven recycling for very large lists.

import shim from "./src/lynx-mithril-shim.js";

// A render function dedicated to list-item content, independent of
// shim.render()/redraw()'s own single-root convenience-API state (which a
// main-thread-owned or data-channel-mode app may already be using for the
// rest of the page). Each item wrapper carries its own `.vnodes`, so reusing
// one render function sequentially across many items/lists is safe — Mithril
// diffs against whatever `.vnodes` is already on the target wrapper.
const renderItemContent = shim();

function typeKeyOf(vnode) {
	return typeof vnode.tag === "string" ? vnode.tag : (vnode.tag && vnode.tag.name) || "default";
}

/**
 * Creates a native-recycled `<list>` element, scoped to the same component
 * as `parentNode` (anything with an `ownerDocument`, e.g. a real
 * LynxNodeWrapper). `renderItem(index)` must return a fresh Mithril vnode
 * for that cell's content every time it's called — it may be called more
 * than once for the same index (recycling).
 *
 * `scrollOrientation`/`listType`/`spanCount` and each item's `item-key` are
 * NOT optional in practice, even though native's __CreateList/componentAtIndex
 * types don't require them: every real @lynx-js/react list example sets all
 * of these unconditionally (verified by reading lynx-examples/examples/list's
 * base/recyclable/async-rendering demos — see ../LIST_INVESTIGATION.md), and
 * a real device never called componentAtIndex at all without them. Defaults
 * here match what those examples use for the simple single-column case.
 */
export function createList(parentNode, options) {
	const {
		itemCount,
		renderItem,
		itemKey,
		className,
		scrollOrientation = "vertical",
		listType = "single",
		spanCount = 1,
	} = options;
	let count = itemCount;
	const pageId = parentNode.ownerDocument._pageId;
	const keyOf = typeof itemKey === "function" ? itemKey : (index) => String(index);

	// itemType -> Map<sign, ItemEntry>, the reuse pool.
	const recycleMap = new Map();
	// sign -> ItemEntry, currently-bound (visible) items.
	const signMap = new Map();

	function bindFreshItem(listHandle, listId, cellIndex, opId, vnode, typeKey) {
		const itemWrapper = parentNode.ownerDocument.createElement("list-item");
		__SetAttribute(itemWrapper._handle, "item-key", keyOf(cellIndex));
		__AppendElement(listHandle, itemWrapper._handle);
		renderItemContent(itemWrapper, vnode);

		const sign = __GetElementUniqueID(itemWrapper._handle);
		signMap.set(sign, { wrapper: itemWrapper, typeKey });
		__FlushElementTree(itemWrapper._handle, { triggerLayout: true, operationID: opId, elementID: sign, listID: listId });
		return sign;
	}

	function bindRecycledItem(listId, cellIndex, opId, vnode, pool) {
		const [sign, entry] = pool.entries().next().value;
		pool.delete(sign);
		// The recycled wrapper is now bound to a DIFFERENT index — its
		// item-key must be updated to match, the same way its content does.
		__SetAttribute(entry.wrapper._handle, "item-key", keyOf(cellIndex));
		renderItemContent(entry.wrapper, vnode);
		signMap.set(sign, entry);
		__FlushElementTree(entry.wrapper._handle, { triggerLayout: true, operationID: opId, elementID: sign, listID: listId });
		return sign;
	}

	function componentAtIndex(listHandle, listId, cellIndex, opId) {
		if (cellIndex < 0 || cellIndex >= count) {
			throw new Error(`mithril-lynx list: cellIndex ${cellIndex} out of range (itemCount=${count})`);
		}
		const vnode = renderItem(cellIndex);
		const typeKey = typeKeyOf(vnode);
		const pool = recycleMap.get(typeKey);
		if (pool && pool.size > 0) return bindRecycledItem(listId, cellIndex, opId, vnode, pool);
		return bindFreshItem(listHandle, listId, cellIndex, opId, vnode, typeKey);
	}

	function enqueueComponent(_listHandle, _listId, sign) {
		const entry = signMap.get(sign);
		if (entry == null) return;
		signMap.delete(sign);
		if (!recycleMap.has(entry.typeKey)) recycleMap.set(entry.typeKey, new Map());
		recycleMap.get(entry.typeKey).set(sign, entry);
	}

	// THE missing piece (see LIST_INVESTIGATION.md): __CreateList + attributes
	// alone never triggers componentAtIndex — native only starts requesting
	// cells once it's told, via a special "update-list-info" attribute, which
	// positions currently exist. Ported from @lynx-js/react's OWN
	// runtime/lib/snapshot/list/listUpdateInfo.js (ListUpdateInfoRecording.flush()),
	// which sends this on every list-children change, alongside a matching
	// __UpdateListCallbacks call. Each insertAction entry needs an "item-key"
	// (dash-case — confirmed by a real device rejecting the first attempt,
	// which omitted it, with "Error for illegal list item-key in parse
	// insertAction"; the exact key name matches ReactLynx's own
	// `__listItemPlatformInfo['item-key']`, a raw JSX-prop-shaped bag it
	// spreads into each entry). `type` per entry is still UNCONFIRMED —
	// ReactLynx's version uses its own component-type reference there
	// (meaningful only to its own recycling, not to native, as far as this
	// file's reading of the source can tell); a constant string is used
	// here since this port's own type-based recycling (typeKeyOf(), above)
	// is tracked independently, in this module, not through native's copy
	// of `type`.
	function sendListInfo(insertAction, removeAction, updateAction) {
		__SetAttribute(listHandle, "update-list-info", { insertAction, removeAction, updateAction });
		__UpdateListCallbacks(listHandle, componentAtIndex, enqueueComponent);
	}

	function insertEntry(position) {
		return { position, type: "cell", "item-key": keyOf(position) };
	}

	const listHandle = __CreateList(pageId, componentAtIndex, enqueueComponent, {});
	__SetAttribute(listHandle, "scroll-orientation", scrollOrientation);
	__SetAttribute(listHandle, "list-type", listType);
	__SetAttribute(listHandle, "span-count", String(spanCount));
	if (className != null) __SetClasses(listHandle, className);

	sendListInfo(
		Array.from({ length: count }, (_, position) => insertEntry(position)),
		[],
		[],
	);

	return {
		_handle: listHandle,
		nodeType: 1,
		/** Call after mutating the underlying data so a subsequently-scrolled-into-view cell reflects the new count. */
		setItemCount(nextCount) {
			if (nextCount === count) return;
			if (nextCount > count) {
				sendListInfo(
					Array.from({ length: nextCount - count }, (_, i) => insertEntry(count + i)),
					[],
					[],
				);
			} else {
				const removed = Array.from({ length: count - nextCount }, (_, i) => nextCount + i);
				sendListInfo([], removed, []);
			}
			count = nextCount;
		},
	};
}
