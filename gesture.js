// gesture.js
//
// Gesture composition API (project plan, Phase 7), main-thread only. Built
// on __SetGestureDetector — a plain, same-thread PAPI call (no cross-thread
// serialization boundary), so this needs nothing beyond a real node handle
// PLUS the small worklet-registration step below. A callback that needs to
// notify background-owned state can call main-thread.js's
// runOnBackground() itself, inside the callback body — an explicit, opt-in
// cross-thread hop only where the app actually needs one.
//
// RESOLVED (2026-09-09), via the SAME technique used to fix list.js's Tier
// 2 (read the real, shipped @lynx-js/react source more deeply — see
// DEVICE_VERIFICATION.md), plus one config-level bug found the hard way.
// THREE issues stacked here, found and fixed in this order:
//
// 1. The config/relationMap shape below matches @lynx-js/react's own
//    runtime/lib/snapshot/gesture/processGesture.js verbatim (real, shipped
//    code — __SetGestureDetector for both create and update, has-react-
//    gesture/flatten set first). But that file's own callback slot type is
//    loose (`callback: unknown`) — reading one file deeper,
//    runtime/lib/worklet-runtime/workletRuntime.js, revealed native invokes
//    gesture callbacks through a global `runWorklet(ctx, params)`, whose
//    `validateWorklet(ctx)` requires `typeof ctx === 'object'`. A plain JS
//    function fails that and is dropped with NO error — exactly this
//    project's first real-device symptom (zero console output on a swipe).
//    Fixed by `./src/worklet-runtime.js`'s `wrapWorkletCallback()`.
// 2. Even with (1) fixed, still zero output — because `enableNewGesture`
//    (a Lynx SDK compiler/runtime option, @lynx-js/type-config's
//    config.d.ts, `@defaultValue false`) was never turned on for this app.
//    Without it, __SetGestureDetector registrations are accepted but the
//    runtime keeps using "the legacy touch-only gesture path" and never
//    acts on them at all — see the consuming app's lynx.config.ts.
// 3. With both fixed, native finally called into JS — and immediately threw
//    `TypeError: not a object`. Bisected step-by-step on-device: native
//    calls a gesture callback with TWO arguments, `(event, controller)`,
//    where `controller` is a native host object (`{__SetGestureState,
//    __ConsumeGesture}`). That object throws when it crosses
//    `Function.prototype.apply()`'s argument-list marshalling, but is fine
//    passed positionally — matching @lynx-js/react's own runWorkletImpl,
//    which never uses apply()/call() either (`worklet(...params_)`, a
//    plain spread call). Fixed in `./src/worklet-runtime.js`.
//
// Confirmed end-to-end on the real device: a full pan (start → update →
// end) updates UI state with zero errors. See `./src/worklet-runtime.js`
// for exactly what's reimplemented vs. scoped out of the real worklet
// runtime, and `callbacks`' new second-argument note below.

import { wrapWorkletCallback } from "./src/worklet-runtime.js";

export const GestureType = {
	COMPOSED: -1,
	PAN: 0,
	FLING: 1,
	DEFAULT: 2,
	TAP: 3,
	LONGPRESS: 4,
	ROTATION: 5,
	PINCH: 6,
	NATIVE: 7,
};

let nextGestureId = 1;

/**
 * Registers a gesture detector on `node` (anything with a `_handle`, i.e. a
 * real LynxNodeWrapper). `type` is a GestureType value or its string key
 * ("pan", "tap", ...). `callbacks` keys are event names (e.g. "onStart",
 * "onUpdate", "onEnd") mapped to plain functions, called directly, same
 * thread. Each is invoked as `(event, controller) => {}` — `controller`
 * (`{__SetGestureState, __ConsumeGesture}`) is a native gesture-arena
 * handle; most callbacks can ignore it entirely.
 * `waitFor`/`simultaneousWith`/`continueWith` are arrays of OTHER
 * createGesture() return values, for gesture-arena composition.
 */
export function createGesture(node, options) {
	const {
		type,
		callbacks = {},
		waitFor = [],
		simultaneousWith = [],
		continueWith = [],
		config,
	} = options;
	const handle = node._handle;
	const gestureType = typeof type === "string" ? GestureType[type.toUpperCase()] : type;
	const id = nextGestureId++;

	// Marker attributes native needs to recognize a gesture-enabled element —
	// kept verbatim from processGesture.js's own names/values, since it's
	// unclear whether native checks these exact strings independent of
	// framework, or whether they're purely a ReactLynx-side bookkeeping detail.
	__SetAttribute(handle, "has-react-gesture", true);
	__SetAttribute(handle, "flatten", false);

	const detectorConfig = {
		callbacks: Object.keys(callbacks).map((name) => ({ name, callback: wrapWorkletCallback(callbacks[name]) })),
	};
	if (config != null) detectorConfig.config = config;

	const relationMap = {
		waitFor: waitFor.map((g) => g.id),
		simultaneous: simultaneousWith.map((g) => g.id),
		continueWith: continueWith.map((g) => g.id),
	};

	__SetGestureDetector(handle, id, gestureType, detectorConfig, relationMap);

	return {
		id,
		remove() {
			if (typeof __RemoveGestureDetector === "function") __RemoveGestureDetector(handle, id);
		},
		setState(state) {
			__SetGestureState(handle, id, state);
		},
	};
}
