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
});

/**
 * Encodes one op onto a flat ops array. Kept as a tiny helper (not a class)
 * so the hot path (called on every attribute/child mutation during a real
 * Mithril diff) is just array pushes — no object allocation per op.
 */
export function pushOp(ops, opcode, ...args) {
	ops.push(opcode, ...args);
}
