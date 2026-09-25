// src/apply-patch.js
//
// The main-thread half of the patch protocol. Deliberately NOT a DOM for
// the app's OWN tree — it never runs Mithril's render.js for that (only
// the background thread does, see background.js) — it is a direct,
// low-level interpreter of the flat op array straight onto the real
// Element PAPI, in the spirit of ReactLynx's own `snapshotPatchApply.js`
// (see rspeedy-react-analysis/LYNX_PAPI_SPEC.md §4.3): a switch over op
// codes, one real PAPI call per case, nothing else. Op.CreateList's own
// cell content (list-support.js) is no exception to that: componentAtIndex
// replays ops the background thread already computed (list-cell.js), the
// same way this function replays the app's own top-level tree — see
// docs/native-papi/papi-06-virtualized-lists.md in mithril-lynx-ui.
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
import { createNativeList } from "./list-support.js";

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
/**
 * Installs the global worklet registry native requires (`registerWorklet`/`runWorklet`) if not already present.
 * @returns {void}
 */
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
/**
 * Registers a gesture callback in the worklet registry under a fresh id.
 * @param {Function} fn - The callback native should invoke.
 * @returns {{_wkltId: string}} The worklet context object to hand to `__SetGestureDetector`.
 */
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
 * @param {{mode?: "claim"|"axis-lock", axis?: "horizontal"|"vertical", referenceMoves?: number}} [policy] - The claim/release policy; defaults to `{ mode: "claim" }`.
 * @returns {{onDown: (x: number, y: number, consume: (claim: boolean) => void) => void, onMove: (x: number, y: number, consume: (claim: boolean) => void, fail: () => void) => void}} The tracker driven by native touch events.
 */
function createArenaTracker(policy) {
	const mode = (policy && policy.mode) || "claim";
	let refX = null;
	let refY = null;
	let movesSeen = 0;
	let decided = false;

	return {
		/**
		 * Handles touches-down: claims the gesture and records the reference point when applicable.
		 * @param {number} x - Touch `clientX`.
		 * @param {number} y - Touch `clientY`.
		 * @param {(claim: boolean) => void} consume - Claims (`true`) or releases (`false`) the gesture arena.
		 * @returns {void}
		 */
		onDown(x, y, consume) {
			consume(true);
			if (mode === "axis-lock" && (policy.referenceMoves || 0) === 0) {
				refX = x;
				refY = y;
			}
		},
		/**
		 * Handles touches-move: for `axis-lock`, decides once whether the dominant axis matches, otherwise releases and fails the gesture.
		 * @param {number} x - Touch `clientX`.
		 * @param {number} y - Touch `clientY`.
		 * @param {(claim: boolean) => void} consume - Claims (`true`) or releases (`false`) the gesture arena.
		 * @param {() => void} fail - Marks the gesture as failed.
		 * @returns {void}
		 */
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
			if (wins) {
				consume(true);
			} else {
				// Release the claim touches-down made eagerly, THEN fail —
				// both, not just the latter: a bare fail() with the arena
				// still marked "claimed" would keep blocking an ancestor
				// (e.g. a <scroll-view>) from ever seeing this touch.
				consume(false);
				fail();
			}
		},
	};
}

/**
 * Registers a native gesture detector on an element and forwards its touch events to the background thread.
 * @param {*} handle - The real PAPI element handle.
 * @param {number} id - The background-side element id.
 * @param {number} gestureId - The gesture id allocated on the background thread.
 * @param {string|number} gestureType - A gesture type name (e.g. `"pan"`) or its numeric code.
 * @param {{mode?: string, axis?: string, referenceMoves?: number}} [arenaPolicy] - The claim/release policy.
 * @param {(id: number, type: string, payload: unknown) => void} [onEvent] - Receives `gesturedown`/`gesturemove`/`gestureup` events.
 * @returns {void}
 */
function registerGestureDetector(handle, id, gestureId, gestureType, arenaPolicy, onEvent) {
	const tracker = createArenaTracker(arenaPolicy);
	const gestureTypeCode = typeof gestureType === "string" ? GESTURE_TYPE_CODES[gestureType] : gestureType;

	/**
	 * @param {*} controller - The native gesture controller passed to the callback.
	 * @param {boolean} shouldClaim - Whether to claim (`true`) or release (`false`) the arena.
	 * @returns {void}
	 */
	function consume(controller, shouldClaim) {
		if (controller != null && typeof controller.__ConsumeGesture === "function") {
			controller.__ConsumeGesture(handle, gestureId, { consume: shouldClaim, inner: false });
		}
	}
	/**
	 * @param {*} controller - The native gesture controller passed to the callback.
	 * @returns {void}
	 */
	function fail(controller) {
		if (controller != null && typeof controller.__SetGestureState === "function") {
			controller.__SetGestureState(handle, gestureId, GestureState.fail);
		}
	}
	// timestamp: a real field native's own touch/gesture params already
	// carry (mithril-lynx v1's gesture consumers already read
	// event.params.timestamp for velocity calculations) — forwarded as-is
	// rather than having a consumer approximate it from receipt time on
	// the background thread, which would fold cross-thread forwarding
	// latency into a velocity computation.
	/**
	 * @param {{params?: {clientX?: number, clientY?: number, timestamp?: number}}} [event] - A native touch/gesture event.
	 * @returns {{clientX: number|undefined, clientY: number|undefined, timestamp: number|undefined}} The event's coordinates and timestamp.
	 */
	function coordsOf(event) {
		const p = (event && event.params) || {};
		return { clientX: p.clientX, clientY: p.clientY, timestamp: p.timestamp };
	}

	const callbacks = {
		onTouchesDown: (event, controller) => {
			const coords = coordsOf(event);
			tracker.onDown(coords.clientX, coords.clientY, (claim) => consume(controller, claim));
			onEvent?.(id, "gesturedown", coords);
		},
		onTouchesMove: (event, controller) => {
			const coords = coordsOf(event);
			tracker.onMove(coords.clientX, coords.clientY, (claim) => consume(controller, claim), () => fail(controller));
			onEvent?.(id, "gesturemove", coords);
		},
		onTouchesUp: (event) => {
			onEvent?.(id, "gestureup", coordsOf(event));
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
 * @param {object} [options]
 * @param {Function} [options.onEvent]
 * @param {boolean} [options.flush] - Whether `applyPatch` calls the bare,
 *   whole-page `__FlushElementTree()` after applying its ops. Defaults to
 *   `true` — the right default for the ONE real top-level applier per page
 *   (main-thread.js's own use). `false` for a per-cell applier
 *   (list-support.js): a list cell's real commit point is the list-specific
 *   `__FlushElementTree(wrapperHandle, {triggerLayout, operationID,
 *   elementID, listID})` call list-support.js already makes right after —
 *   calling the bare, whole-page flush too, from inside native's own
 *   synchronous componentAtIndex callback, is a second, unrelated flush this
 *   applier was never meant to trigger on that call site's behalf.
 * @returns {{registerPageRoot: (pageElementHandle: *) => void, registerRoot: (id: number, handle: *) => void, applyPatch: (ops: unknown[]) => void, getHandle: (id: number) => *}} The patch applier.
 */
export function createPatchApplier(pageId, { onEvent, flush = true } = {}) {
	// id (as allocated by the background's virtual backend) -> real PAPI
	// element handle. id 0 is reserved for "the page itself" (see
	// fake-dom.js's LynxDocument) — pre-seeded here so the very first
	// InsertBefore/AppendChild targeting id 0 has somewhere real to land.
	const handles = new Map();
	// list id -> its setCells(cells) function (list-support.js) — kept here,
	// not as a property on the list's own handle: a real native list handle
	// does not reliably hold a custom property across calls (confirmed on
	// device), only `handles` (a plain Map) does.
	const listSetters = new Map();

	// id -> Map<event type, listener callback>. `__AddEventListener` needs the
	// exact callback reference back when `__RemoveEventListener` runs, so the
	// listener cannot be an inline closure re-created per Op.AddEvent — it is
	// stored here and reused by the Op.RemoveEvent case.
	const eventListeners = new Map();

	/** General form: seed the mapping for any id, not just the page root —
	 * list-support.js uses this to alias a list-cell.js `containerId` (an
	 * off-tree id from the background thread's OWN document) to the real
	 * native wrapper element it created for that cell.
	 * @param {number} id - The background-side id to alias.
	 * @param {*} handle - The real PAPI element handle it maps to.
	 * @returns {void}
	 */
	function registerRoot(id, handle) {
		handles.set(id, handle);
	}

	/**
	 * Maps the reserved id `0` to the real page element.
	 * @param {*} pageElementHandle - The page element created by `__CreatePage`.
	 * @returns {void}
	 */
	function registerPageRoot(pageElementHandle) {
		registerRoot(0, pageElementHandle);
	}

	/**
	 * Creates the real PAPI element for a tag.
	 * @param {string} tag - The tag name (`view` and `text` use their dedicated creators).
	 * @returns {*} The new element handle.
	 */
	function createElementHandle(tag) {
		if (tag === "view") return __CreateView(pageId);
		if (tag === "text") return __CreateText(pageId);
		return __CreateElement(tag, pageId, {});
	}

	/**
	 * Applies one commit's worth of ops, then — unless this applier was
	 * created with `flush: false` (see this function's own constructor
	 * options above) — flushes exactly once with the bare, whole-page
	 * `__FlushElementTree()`; that call is the real commit for the ONE
	 * top-level applier per page, never looked up through a global. A
	 * per-cell applier (list-support.js) passes `flush: false` and issues
	 * its own list-specific `__FlushElementTree(wrapperHandle, {...})` call
	 * afterward instead — that one, not this one, is that cell's real
	 * commit point.
	 * @param {unknown[]} ops - A flat op array (opcode followed by its arguments, repeated).
	 * @returns {void}
	 * @throws {Error} If an unknown opcode is encountered, or `Op.RemoveEvent` needs `__RemoveEventListener` and it is unavailable.
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
					/**
					 * Forwards a native event to the background thread.
					 * @param {*} nativeEvent - The native event object.
					 * @returns {void}
					 */
					const listener = (nativeEvent) => {
						onEvent?.(id, type, nativeEvent);
					};
					let byType = eventListeners.get(id);
					if (byType == null) eventListeners.set(id, (byType = new Map()));
					byType.set(type, listener);
					__AddEventListener(handle, type, listener, {});
					break;
				}
				case Op.RemoveEvent: {
					const id = ops[i++];
					const type = ops[i++];
					const handle = handles.get(id);
					const byType = eventListeners.get(id);
					const listener = byType ? byType.get(type) : undefined;
					if (typeof __RemoveEventListener === "function") {
						// Native Fiber requires the options argument (>= 4 params) and
						// derives the binding slot from it — pass the same `{}` the
						// Op.AddEvent case uses so add/remove target the same slot.
						if (listener != null) __RemoveEventListener(handle, type, listener, {});
					} else if (listener != null) {
						// Failing loudly is deliberate: without __RemoveEventListener a
						// remove→re-add cycle on a kept element would accumulate
						// duplicate native listeners and fire the handler N times per
						// event. A silent no-op here is exactly the class of bug the
						// whole project refuses to ship.
						throw new Error(
							"[mithril-lynx] __RemoveEventListener is not available on this runtime, " +
								"so Op.RemoveEvent cannot be applied — a conditional event handler " +
								"would leak duplicate listeners. Keep the handler constant or " +
								"remove the whole element instead.",
						);
					}
					if (byType != null) {
						byType.delete(type);
						if (byType.size === 0) eventListeners.delete(id);
					}
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
				case Op.CreateList: {
					const id = ops[i++];
					const scrollOrientation = ops[i++];
					const listType = ops[i++];
					const spanCount = ops[i++];
					const { handle, setCells } = createNativeList(pageId, scrollOrientation, listType, spanCount, createPatchApplier, onEvent);
					handles.set(id, handle);
					listSetters.set(id, setCells);
					break;
				}
				case Op.SetListItems: {
					const id = ops[i++];
					const cells = ops[i++];
					listSetters.get(id)(cells);
					break;
				}
				default:
					throw new Error(`[mithril-lynx] Unknown patch opcode: ${opcode}`);
			}
		}
		if (flush) __FlushElementTree();
	}

	return {
		registerPageRoot,
		registerRoot,
		applyPatch,
		/** The real PAPI element handle for a given background-side id, or
		 * `undefined` if nothing was ever created for it. Exists for tests
		 * (see mithril-lynx/testing) that need to correlate a fake-dom node's
		 * `_id` with the real element the testing environment's PAPI
		 * recording (mithril-lynx-v1's own installTestingPolyfills wraps
		 * every `__`-prefixed call regardless of which package called it, so
		 * this is how a v2 test finds "which of those calls targeted THIS
		 * element") — never needed by application code.
		 * @param {number} id - The background-side element id.
		 * @returns {*} The real element handle, or `undefined` when none exists.
		 */
		getHandle(id) {
			return handles.get(id);
		},
	};
}
