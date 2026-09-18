// src/patch-protocol.js
//
// The wire vocabulary between the background thread (real Mithril diff,
// running against a virtual tree) and the main thread (applies the patch to
// real Lynx elements). Adopted from ReactLynx's `SnapshotOperation` pattern
// (see rspeedy-react-analysis/LYNX_PAPI_SPEC.md §4.3): a FLAT array of
// numbers/strings/values, not an array of `{op, ...}` objects — cheaper to
// serialize, and a pattern already proven in production at ReactLynx's scale.
//
// Every op is `[opcode, ...args]` concatenated into one flat array. `id`
// below always refers to the integer handle a node was given by
// `createVirtualBackend()` — the SAME id space is mirrored 1:1 on the
// main-thread side by `applyPatch()` (see backends/papi-backend.js), so
// nodes never need to be looked up by anything other than that integer.

export const Op = Object.freeze({
	CreateElement: 0,
	CreateElementNS: 1,
	CreateText: 2,
	CreateFragment: 3,
	InsertBefore: 4, // parentId, childId, refId(-1 = append)
	RemoveChild: 5, // parentId, childId
	SetAttribute: 6, // id, name, value
	RemoveAttribute: 7, // id, name
	SetAttributeNS: 8, // id, ns, name, value
	SetStyleProperty: 9, // id, name, value (dash-case, via setProperty semantics)
	RemoveStyleProperty: 10, // id, name
	SetText: 11, // id, value (nodeValue on a text node)
	AddEvent: 12, // id, type
	RemoveEvent: 13, // id, type
	// gestureId, gestureType, arenaPolicy — registers a real native gesture
	// detector on the main thread. arenaPolicy is a small, JSON-serializable
	// description of when to claim/release the gesture arena, evaluated
	// synchronously on the main thread against just the event's own
	// coordinates (no background-thread round trip) — see
	// docs/native-papi/papi-05-native-gestures.md in mithril-lynx-ui for
	// the full design writeup and why this is deliberately narrower than a
	// generic remote-controller RPC. Resulting onTouchesDown/Move/Up events
	// are forwarded to the background thread as plain events (type
	// "gesturedown"/"gesturemove"/"gestureup"), through the exact same
	// channel any other native event already uses — nothing new on the
	// background-thread side.
	SetGestureDetector: 14, // id, gestureId, gestureType, arenaPolicy
	RemoveGestureDetector: 15, // id, gestureId
	// A native virtualized list — see docs/native-papi/papi-06-virtualized-lists.md
	// in mithril-lynx-ui for the full design. rendererKey looks up a
	// render function registered on the MAIN thread (mithril-lynx/
	// list-support's registerListRenderer()) — the function itself can't
	// cross the thread boundary, only this string key can.
	CreateList: 16, // id, rendererKey, scrollOrientation, listType, spanCount
	SetListItems: 17, // id, itemsJSON (items must be JSON-serializable — they DO cross the boundary, as data)
});

/**
 * Encodes one op onto a flat ops array. Kept as a tiny helper (not a class)
 * so the hot path (called on every attribute/child mutation during a real
 * Mithril diff) is just array pushes — no object allocation per op.
 */
export function pushOp(ops, opcode, ...args) {
	ops.push(opcode, ...args);
}
