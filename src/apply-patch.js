// src/apply-patch.js
//
// The main-thread half of the patch protocol. Deliberately NOT a DOM — it
// never runs Mithril's render.js (only the background thread does, see
// background.js) — it is a direct, low-level interpreter of the flat op
// array straight onto the real Element PAPI, in the spirit of ReactLynx's
// own `snapshotPatchApply.js` (see rspeedy-react-analysis/LYNX_PAPI_SPEC.md
// §4.3): a switch over op codes, one real PAPI call per case, nothing else.
//
// The exact `__Create*`/pageId contract below (one `pageId` shared by every
// element on a page, `__CreateView`/`__CreateText`/generic `__CreateElement`
// for tags, `__CreateRawText` + `__SetAttribute(id,"text",v)` for raw text
// content) is not a guess — it's the same contract `mithril-lynx/CONTRACT.md`
// + `mithril-lynx/src/lynx-mithril-shim.js` already validated on a real
// device (see mithril-lynx/DEVICE_VERIFICATION.md). Reusing a validated
// mapping here is exactly the kind of "concept, not code" reuse the v2 plan
// allows (§2 non-goals) — the bug we're rewriting away lives in the
// commit/reload layer (commit.js, reload/*.js), never in this mapping.

import { Op } from "./patch-protocol.js";

/**
 * @param {number} pageId - `__GetElementUniqueID(pageElement)` of the real
 *   page this applier is attached to. Every element this applier creates
 *   belongs to that one page — see CONTRACT.md / lynx-mithril-shim.js.
 */
export function createPatchApplier(pageId) {
	// id (as allocated by the background's virtual backend) -> real PAPI
	// element handle. id 0 is reserved for "the page itself" (see
	// fake-dom.js's LynxDocument) — pre-seeded here so the very first
	// InsertBefore/AppendChild targeting id 0 has somewhere real to land.
	const handles = new Map();

	function registerPageRoot(pageElementHandle) {
		handles.set(0, pageElementHandle);
	}

	function createElementHandle(tag) {
		if (tag === "view") return __CreateView(pageId);
		if (tag === "text") return __CreateText(pageId);
		return __CreateElement(tag, pageId, {});
	}

	/**
	 * Applies one commit's worth of ops, then flushes exactly once —
	 * `__FlushElementTree` is the real commit; nothing before it is visible.
	 * This function itself is the ONLY caller of `__FlushElementTree` on
	 * this applier's page — never called conditionally, never looked up
	 * through a global (mirrors the fix in commit.js on the background
	 * side: one explicit call site, not an implicit one).
	 */
	function applyPatch(ops) {
		for (let i = 0; i < ops.length; ) {
			const opcode = ops[i++];
			switch (opcode) {
				case Op.CreateElement: {
					const tag = ops[i++];
					const id = ops[i++];
					handles.set(id, createElementHandle(tag));
					break;
				}
				case Op.CreateElementNS: {
					// Lynx has no XML-namespaced element PAPI distinct from
					// the generic one — CONTRACT.md's createElementNS exists
					// only to satisfy render.js's SVG/MathML path, which
					// mithril-lynx apps don't exercise (no SVG on Lynx).
					const _ns = ops[i++];
					const tag = ops[i++];
					const id = ops[i++];
					handles.set(id, createElementHandle(tag));
					break;
				}
				case Op.CreateText: {
					const value = ops[i++];
					const id = ops[i++];
					handles.set(id, __CreateRawText(String(value)));
					break;
				}
				case Op.InsertBefore: {
					const parentId = ops[i++];
					const childId = ops[i++];
					const refId = ops[i++];
					const parent = handles.get(parentId);
					const child = handles.get(childId);
					if (refId === -1) {
						__AppendElement(parent, child);
					} else {
						__InsertElementBefore(parent, child, handles.get(refId));
					}
					break;
				}
				case Op.RemoveChild: {
					const parentId = ops[i++];
					const childId = ops[i++];
					__RemoveElement(handles.get(parentId), handles.get(childId));
					handles.delete(childId);
					break;
				}
				case Op.SetAttribute: {
					const id = ops[i++];
					const name = ops[i++];
					const value = ops[i++];
					const handle = handles.get(id);
					if (name === "class") __SetClasses(handle, value == null ? "" : value);
					else __SetAttribute(handle, name, value);
					break;
				}
				case Op.RemoveAttribute: {
					const id = ops[i++];
					const name = ops[i++];
					const handle = handles.get(id);
					if (name === "class") __SetClasses(handle, "");
					else __SetAttribute(handle, name, null);
					break;
				}
				case Op.SetAttributeNS: {
					const id = ops[i++];
					const _ns = ops[i++];
					const name = ops[i++];
					const value = ops[i++];
					__SetAttribute(handles.get(id), name, value);
					break;
				}
				case Op.SetStyleProperty: {
					const id = ops[i++];
					const name = ops[i++];
					const value = ops[i++];
					__AddInlineStyle(handles.get(id), name, value);
					break;
				}
				case Op.RemoveStyleProperty: {
					const id = ops[i++];
					const name = ops[i++];
					// `"*"` is fake-dom.js's encoding of `element.style = ""`
					// (clear everything) — there is no bulk-clear PAPI call
					// validated yet, so this case is a documented gap for
					// F3, not a silent no-op: it throws so the gap surfaces
					// as a test failure rather than a mystery on-device.
					if (name === "*") {
						throw new Error(
							"[mithril-lynx-v2] Clearing the whole `style` object at once is not implemented yet (F3 TODO) — set individual properties to \"\" instead.",
						);
					}
					__AddInlineStyle(handles.get(id), name, "");
					break;
				}
				case Op.SetText: {
					const id = ops[i++];
					const value = ops[i++];
					__SetAttribute(handles.get(id), "text", value);
					break;
				}
				case Op.AddEvent: {
					const id = ops[i++];
					const type = ops[i++];
					const handle = handles.get(id);
					__AddEventListener(handle, type, (nativeEvent) => {
						applyPatch.onEvent?.(id, type, nativeEvent);
					}, {});
					break;
				}
				case Op.RemoveEvent: {
					// PAPI has no documented `__RemoveEventListener` in the
					// validated v1 surface (CONTRACT.md never needed it,
					// since mithril-lynx v1 never tore down individual
					// listeners outside of removing the whole element).
					// Left as an explicit no-op + TODO rather than a guess.
					i += 2;
					break;
				}
				default:
					throw new Error(`[mithril-lynx-v2] Unknown patch opcode: ${opcode}`);
			}
		}
		__FlushElementTree();
	}

	return { registerPageRoot, applyPatch };
}
