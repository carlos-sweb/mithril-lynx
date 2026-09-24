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

/**
 * The wire protocol version, prepended to every patch by
 * `sendPatchToMainThread()` and validated (then stripped) by the main
 * thread before any op is interpreted. The two bundles are normally built
 * from the same source, but a partial HMR or a cached main-thread bundle
 * could otherwise re-interpret a reordered opcode silently — a version
 * mismatch throws instead of corrupting the mirrored id space.
 *
 * The value is deliberately outside the 0..17 opcode range (0x4d4c = "ML"
 * in ASCII) so a versioned array can never be misread as an op sequence if
 * it is ever fed to `applyPatch()` without the strip.
 */
export const PROTOCOL_VERSION = 0x4d4c;

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
	// in mithril-lynx-ui for the full design. Each list item is rendered on
	// the BACKGROUND thread, through the app's own real render pass
	// (list-cell.js), same as everything else in the tree — the main thread
	// never runs renderItem() itself, only replays the ops that rendering
	// already produced (apply-patch.js's Op.CreateList case + list-support.js).
	CreateList: 16, // id, scrollOrientation, listType, spanCount
	SetListItems: 17, // id, cells — cells: Array<{ typeKey, containerId, ops, rootChildIds }>, one entry per current item, computed by list-cell.js's renderListCell(). `ops` is a flat op array in this SAME encoding, scoped to `containerId` as its root parent id.
});

/**
 * Encodes one op onto a flat ops array. Kept as a tiny helper (not a class)
 * so the hot path (called on every attribute/child mutation during a real
 * Mithril diff) is just array pushes — no object allocation per op.
 */
export function pushOp(ops, opcode, ...args) {
	ops.push(opcode, ...args);
}

// How many argument slots follow each opcode — the single source of truth
// for walking a flat ops array without re-interpreting it (apply-patch.js's
// own switch increments `i` inline instead of using this table, since it
// also needs to look at individual arg values as it goes; this exists for
// callers that only need to skip/scan, e.g. list-cell.js's
// findTopLevelChildIds(), which never applies the ops itself).
export const OP_ARITY = Object.freeze({
	[Op.CreateElement]: 2, // tag, id
	[Op.CreateElementNS]: 3, // ns, tag, id
	[Op.CreateText]: 2, // value, id
	[Op.CreateFragment]: 1, // id (never actually emitted — see fake-dom.js's LynxFragment)
	[Op.InsertBefore]: 3, // parentId, childId, refId
	[Op.RemoveChild]: 2, // parentId, childId
	[Op.SetAttribute]: 3, // id, name, value
	[Op.RemoveAttribute]: 2, // id, name
	[Op.SetAttributeNS]: 4, // id, ns, name, value
	[Op.SetStyleProperty]: 3, // id, name, value
	[Op.RemoveStyleProperty]: 2, // id, name
	[Op.SetText]: 2, // id, value
	[Op.AddEvent]: 2, // id, type
	[Op.RemoveEvent]: 2, // id, type
	[Op.SetGestureDetector]: 4, // id, gestureId, gestureType, arenaPolicy
	[Op.RemoveGestureDetector]: 2, // id, gestureId
	[Op.CreateList]: 4, // id, scrollOrientation, listType, spanCount
	[Op.SetListItems]: 2, // id, cells
});

/** Walks a flat ops array, calling `visit(opcode, args)` once per op — args
 * is the plain slice of that op's own arguments (not including the opcode
 * itself). Throws on an unknown opcode rather than silently desyncing. */
export function forEachOp(ops, visit) {
	for (let i = 0; i < ops.length; ) {
		const opcode = ops[i++];
		const arity = OP_ARITY[opcode];
		if (arity === undefined) throw new Error(`[mithril-lynx] Unknown patch opcode: ${opcode}`);
		visit(opcode, ops.slice(i, i + arity));
		i += arity;
	}
}
