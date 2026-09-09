// gesture.js
//
// Gesture composition API (project plan, Phase 7), main-thread only. Built
// directly on __SetGestureDetector — a plain, same-thread PAPI call (no
// worklet extraction, no serialization boundary for the common case), so
// this needs nothing from gesture.js's own thread beyond a real node handle.
// A callback that needs to notify background-owned state can call
// main-thread.js's runOnBackground() itself, inside the callback body — an
// explicit, opt-in cross-thread hop only where the app actually needs one,
// not something gesture composition requires structurally.
//
// UNVERIFIED ON A REAL DEVICE (see the project plan's "Parity boundaries"
// section, point 3): the config/relationMap shape below is copied verbatim
// from @lynx-js/react's own runtime/lib/snapshot/gesture/processGesture.js
// (a real, shipped implementation, not guesswork), including calling
// __SetGestureDetector for BOTH create and update (that file never calls
// __CreateGestureDetector, despite it existing in the PAPI type
// declarations) and setting the `has-react-gesture`/`flatten` attributes
// before registering the detector. What's NOT verified here: whether
// native's __SetGestureDetector callback slot accepts a plain JS function
// (this file's assumption, consistent with gestures being main-thread/
// same-thread) or specifically expects a Worklet-shaped object — ReactLynx
// always uses worklets for gesture callbacks, so this exact question was
// never exercised by an existing zero-compiler implementation.

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
 * thread. `waitFor`/`simultaneousWith`/`continueWith` are arrays of OTHER
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
		callbacks: Object.keys(callbacks).map((name) => ({ name, callback: callbacks[name] })),
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
