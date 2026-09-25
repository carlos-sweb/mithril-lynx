// src/testing.js
//
// Reusable @lynx-js/testing-environment PAPI polyfill + patch applier for
// apps/libraries built on mithril-lynx, not just this package's own test
// suite — same reason the previous mithril-lynx exposed its own
// mithril-lynx/testing: a separate package (mithril-lynx-ui, or any app)
// needs the exact same gap-fill to write a REAL end-to-end test (mount via
// renderApp(), replay the resulting ops onto real Element PAPI via
// @lynx-js/testing-environment, dispatch a real event) rather than mocking
// mithril-lynx itself.
//
// Usage, in a test setup file (e.g. test/setup.ts):
//
//   import { installTestingPolyfills } from "mithril-lynx/testing";
//   globalThis.onInjectMainThreadGlobals = installTestingPolyfills;
//
// createPatchApplier is re-exported here too — it's what a test needs to
// actually replay a renderApp() root's ops onto real PAPI elements (see
// this package's own test/end-to-end.test.ts for the full pattern); it has
// no other public export point.

export { createPatchApplier } from "./apply-patch.js";

/**
 * Installs the polyfill on the main-thread globals object
 * @lynx-js/testing-environment hands to onInjectMainThreadGlobals. Scoped
 * to the one real gap: @lynx-js/testing-environment already implements
 * __CreateView/__CreateText/__CreateElement/__CreateRawText/__AppendElement/
 * __InsertElementBefore/__RemoveElement/__SetAttribute/__SetClasses/
 * __AddInlineStyle/__FlushElementTree/__GetElementUniqueID — the missing
 * piece is __AddEventListener/__RemoveEventListener (the testing environment
 * only implements the string/worklet-event __AddEvent family that ReactLynx
 * uses; mithril-lynx binds real JS function listeners directly). Gesture and
 * list elements (Op.SetGestureDetector, `list`/`list-item`) are covered by the testing
 * environment itself, not by this polyfill — see test/gesture.test.ts and
 * test/list.test.ts.
 * @param {{lynx: Object}} target - The main-thread globals object from `@lynx-js/testing-environment`.
 * @returns {void}
 */
export function installTestingPolyfills(target) {
	target.lynx.getEngine = target.lynx.getNative;

	// Faithful stand-ins for the native `__AddEventListener` /
	// `__RemoveEventListener` PAPIs (element, name, callback, options). The
	// options object is accepted and ignored here — the real native side
	// requires it (FiberRemoveEventListener throws "param size should >= 4"
	// without it), so __RemoveEventListener mirrors that arity requirement to
	// keep the test environment honest about the wire contract.
	/**
	 * Stand-in for the native `__AddEventListener` PAPI.
	 * @param {Object} node - The element.
	 * @param {string} name - The event type.
	 * @param {Function} handler - The listener.
	 * @param {Object} _options - Accepted and ignored.
	 * @returns {void}
	 */
	target.__AddEventListener = (node, name, handler, _options) => {
		node.__vanillaListeners ??= {};
		(node.__vanillaListeners[name] ??= new Set()).add(handler);
	};

	/**
	 * Stand-in for the native `__RemoveEventListener` PAPI.
	 * @param {Object} node - The element.
	 * @param {string} name - The event type.
	 * @param {Function} handler - The listener to remove.
	 * @param {Object} _options - Required (four arguments), mirroring native.
	 * @returns {void}
	 * @throws {Error} If called with fewer than four arguments.
	 */
	target.__RemoveEventListener = function (node, name, handler, _options) {
		if (arguments.length < 4) {
			throw new Error(
				"[mithril-lynx/testing] __RemoveEventListener requires 4 params " +
					"(element, name, callback, options) — matching FiberRemoveEventListener.",
			);
		}
		node.__vanillaListeners?.[name]?.delete(handler);
	};
}
