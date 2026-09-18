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
// mapping here is exactly the kind of "concept, not code" reuse the plan
// allows (§2 non-goals) — the bug this rewrite fixes lives in the
// commit/reload layer (commit.js, reload/*.js), never in this mapping.

import { Op } from "./patch-protocol.js";

// --- Native gesture support (Op.SetGestureDetector) ------------------------
//
// See patch-protocol.js's own note and mithril-lynx-ui's
// docs/native-papi/papi-05-native-gestures.md for the full design writeup.
// Everything below runs on the MAIN thread, synchronously, inside a native
// gesture callback — never on the background thread, and never waits on a
// round trip to it. The arena-claim decision (arenaPolicy) is evaluated
// here using only the event's own coordinates; the resulting touches-down/
// move/up events are then forwarded to the background thread as ordinary
// events (via `onEvent`, the exact same callback Op.AddEvent already uses),
// so app code sees them as plain "gesturedown"/"gesturemove"/"gestureup"
// listeners with no gesture-specific machinery of its own.

const GESTURE_TYPE_CODES = { composed: -1, pan: 0, fling: 1, default: 2, tap: 3, longpress: 4, rotation: 5, pinch: 6, native: 7 };
const GestureState = { active: 1, fail: 2, end: 3 };

// Native does not call a gesture callback function directly — it calls a
// global `runWorklet(ctx, params)`, looking up the real function by
// `ctx._wkltId`. This is a real native requirement (confirmed on device by
// this project's own predecessor, mithril-lynx v1's gesture.js), not
// specific to any one package — every gesture callback has to be wrapped
// through this registry before being handed to __SetGestureDetector.
function ensureWorkletRuntime() {
	if (globalThis.lynxWorkletImpl !== undefined) return;
	globalThis.lynxWorkletImpl = { _workletMap: {} };
	globalThis.registerWorklet = function (_type, id, fn) {
		globalThis.lynxWorkletImpl._workletMap[id] = fn;
	};
	globalThis.runWorklet = function (ctx, params) {
		if (typeof ctx !== "object" || ctx === null || !("_wkltId" in ctx)) return;
		const fn = globalThis.lynxWorkletImpl._workletMap[ctx._wkltId];
		if (typeof fn !== "function") return;
		const args = Array.isArray(params) ? params : params != null ? [params] : [];
		// A plain call, deliberately not .apply()/.call() — native's own
		// `controller` argument throws if marshalled through either (same
		// finding mithril-lynx v1's gesture.js already made).
		return fn.bind(ctx)(...args);
	};
}

let nextWorkletId = 1;
function wrapWorkletCallback(fn) {
	ensureWorkletRuntime();
	const id = "mithril-lynx-gesture-" + nextWorkletId++;
	globalThis.registerWorklet("main-thread", id, fn);
	return { _wkltId: id };
}

/**
 * A small, generic claim/release policy — covers the two real shapes this
 * project's consumers need, not an arbitrary one:
 *   - `{ mode: "claim" }` — claim on touches-down, never reconsider (a
 *     single-axis drag with nothing else competing for the gesture).
 *   - `{ mode: "axis-lock", axis: "horizontal" | "vertical", referenceMoves }`
 *     — claim eagerly on touches-down, then on the move `referenceMoves + 1`
 *     (0: decide using the down position as reference, right on the first
 *     move; 1: use the first move's own position as reference and decide on
 *     the second), release and fail the gesture if the dominant axis of the
 *     resulting delta doesn't match `axis`.
 * Unverified on a real device (no device access this session) — the claim
 * timing (down vs. first/second move) mirrors what mithril-lynx v1's own
 * device-verified sheet.js/swipe-action.js/swiper.js already did; the NEW
 * part, evaluating it here instead of in app code, has not been confirmed
 * to feel the same on-device.
 */
function createArenaTracker(policy) {
	const mode = (policy && policy.mode) || "claim";
	let refX = null;
	let refY = null;
	let movesSeen = 0;
	let decided = false;

	return {
		onDown(x, y, consume) {
			consume(true);
			if (mode === "axis-lock" && (policy.referenceMoves || 0) === 0) {
				refX = x;
				refY = y;
			}
		},
		onMove(x, y, consume, fail) {
			if (mode !== "axis-lock" || decided) return;
			if ((policy.referenceMoves || 0) === 1 && movesSeen === 0) {
				refX = x;
				refY = y;
				movesSeen++;
				return;
			}
			movesSeen++;
			if (refX == null) return;
			const dx = x - refX;
			const dy = y - refY;
			if (dx === 0 && dy === 0) return; // not enough signal yet
			decided = true;
			const isHorizontal = Math.abs(dx) >= Math.abs(dy);
			const wins = policy.axis === "horizontal" ? isHorizontal : !isHorizontal;
			if (wins) consume(true);
			else fail();
		},
	};
}

function registerGestureDetector(handle, id, gestureId, gestureType, arenaPolicy, onEvent) {
	const tracker = createArenaTracker(arenaPolicy);
	const gestureTypeCode = typeof gestureType === "string" ? GESTURE_TYPE_CODES[gestureType] : gestureType;

	function consume(controller, shouldClaim) {
		if (controller != null && typeof controller.__ConsumeGesture === "function") {
			controller.__ConsumeGesture(handle, gestureId, { consume: shouldClaim, inner: false });
		}
	}
	function fail(controller) {
		if (controller != null && typeof controller.__SetGestureState === "function") {
			controller.__SetGestureState(handle, gestureId, GestureState.fail);
		}
	}
	function coordsOf(event) {
		const p = (event && event.params) || {};
		return { clientX: p.clientX, clientY: p.clientY };
	}

	const callbacks = {
		onTouchesDown: (event, controller) => {
			const { clientX, clientY } = coordsOf(event);
			tracker.onDown(clientX, clientY, (claim) => consume(controller, claim));
			onEvent?.(id, "gesturedown", { clientX, clientY });
		},
		onTouchesMove: (event, controller) => {
			const { clientX, clientY } = coordsOf(event);
			tracker.onMove(clientX, clientY, (claim) => consume(controller, claim), () => fail(controller));
			onEvent?.(id, "gesturemove", { clientX, clientY });
		},
		onTouchesUp: (event) => {
			const { clientX, clientY } = coordsOf(event);
			onEvent?.(id, "gestureup", { clientX, clientY });
		},
	};

	__SetAttribute(handle, "has-react-gesture", true);
	__SetAttribute(handle, "flatten", false);
	__SetGestureDetector(
		handle,
		gestureId,
		gestureTypeCode,
		{ callbacks: Object.keys(callbacks).map((name) => ({ name, callback: wrapWorkletCallback(callbacks[name]) })) },
		{},
	);
}

/**
 * @param {number} pageId - `__GetElementUniqueID(pageElement)` of the real
 *   page this applier is attached to. Every element this applier creates
 *   belongs to that one page — see CONTRACT.md / lynx-mithril-shim.js.
 */
export function createPatchApplier(pageId, { onEvent } = {}) {
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
					// "class" and "id" each have their own dedicated PAPI call
					// (__SetClasses/__SetID) — __SetAttribute itself rejects
					// both ("Cannot use __SetAttribute for \"class\"/\"id\"").
					// Found porting a component that assigns a native `id` for
					// an imperative selector-query ref (see mithril-lynx-ui's
					// docs/native-papi/papi-01-imperative-refs.md) — nothing
					// in this rewrite's own test suite had set `id` before.
					if (name === "class") __SetClasses(handle, value == null ? "" : value);
					else if (name === "id") __SetID(handle, value == null ? null : value);
					else __SetAttribute(handle, name, value);
					break;
				}
				case Op.RemoveAttribute: {
					const id = ops[i++];
					const name = ops[i++];
					const handle = handles.get(id);
					if (name === "class") __SetClasses(handle, "");
					else if (name === "id") __SetID(handle, null);
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
							"[mithril-lynx] Clearing the whole `style` object at once is not implemented yet (F3 TODO) — set individual properties to \"\" instead.",
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
						onEvent?.(id, type, nativeEvent);
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
				case Op.SetGestureDetector: {
					const id = ops[i++];
					const gestureId = ops[i++];
					const gestureType = ops[i++];
					const arenaPolicy = ops[i++];
					const handle = handles.get(id);
					registerGestureDetector(handle, id, gestureId, gestureType, arenaPolicy, onEvent);
					break;
				}
				case Op.RemoveGestureDetector: {
					const id = ops[i++];
					const gestureId = ops[i++];
					const handle = handles.get(id);
					if (typeof __RemoveGestureDetector === "function") __RemoveGestureDetector(handle, gestureId);
					break;
				}
				default:
					throw new Error(`[mithril-lynx] Unknown patch opcode: ${opcode}`);
			}
		}
		__FlushElementTree();
	}

	return {
		registerPageRoot,
		applyPatch,
		/** The real PAPI element handle for a given background-side id, or
		 * `undefined` if nothing was ever created for it. Exists for tests
		 * (see mithril-lynx/testing) that need to correlate a fake-dom node's
		 * `_id` with the real element the testing environment's PAPI
		 * recording (mithril-lynx-v1's own installTestingPolyfills wraps
		 * every `__`-prefixed call regardless of which package called it, so
		 * this is how a v2 test finds "which of those calls targeted THIS
		 * element") — never needed by application code. */
		getHandle(id) {
			return handles.get(id);
		},
	};
}
