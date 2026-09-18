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
 * to exactly what apply-patch.js calls (no gesture/list support — those
 * don't exist in mithril-lynx yet, see the main README's known gaps):
 * @lynx-js/testing-environment already implements __CreateView/__CreateText/
 * __CreateElement/__CreateRawText/__AppendElement/__InsertElementBefore/
 * __RemoveElement/__SetAttribute/__SetClasses/__AddInlineStyle/
 * __FlushElementTree/__GetElementUniqueID — the one real gap is
 * __AddEventListener (the testing environment only implements the
 * string/worklet-event __AddEvent family that ReactLynx uses; mithril-lynx
 * binds real JS function listeners directly).
 */
export function installTestingPolyfills(target) {
	target.lynx.getEngine = target.lynx.getNative;

	target.__AddEventListener = (node, name, handler) => {
		node.__vanillaListeners ??= {};
		(node.__vanillaListeners[name] ??= new Set()).add(handler);
	};

	target.__RemoveEventListener = (node, name, handler) => {
		node.__vanillaListeners?.[name]?.delete(handler);
	};
}
