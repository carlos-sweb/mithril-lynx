// testing.js
//
// Reusable @lynx-js/testing-environment PAPI polyfill for mithril-lynx apps
// (project plan, Phase 9). @lynx-js/testing-environment implements the
// string/worklet event PAPI ReactLynx uses (__AddEvent); the shim binds REAL
// JS function listeners through __AddEventListener, so that family — plus a
// handful of other PAPI functions the testing environment doesn't implement
// at all (used by element.js/gesture.js/list.js) — is polyfilled here.
//
// Usage, in a test setup file (e.g. test/setup.ts):
//
//   import { installTestingPolyfills } from "mithril-lynx/testing";
//   globalThis.onInjectMainThreadGlobals = installTestingPolyfills;
//
// Originally lived duplicated in mithril-app's own test/setup.ts and this
// package's; extracted here once both copies needed the exact same fixes
// (getEngine alias, __SetGestureState, __InvokeUIMethod) independently.

const papiCalls = [];

function record(name, fn) {
	const wrapped = (...args) => {
		papiCalls.push({ fn: name, args });
		return fn(...args);
	};
	wrapped.__papiRecorded = true;
	return wrapped;
}

/**
 * Installs the polyfill on the main-thread globals object
 * @lynx-js/testing-environment hands to onInjectMainThreadGlobals.
 */
export function installTestingPolyfills(target) {
	// The testing environment exposes the native page-lifecycle event bus via
	// lynx.getNative() (addEventListener/removeEventListener/dispatchEvent),
	// but doesn't alias it to getEngine() (what real Lynx and mithril-lynx's
	// main-thread.js call). Alias it here so setupApp()/setupRenderer() can
	// register for __RenderPage/__UpdatePage/__DestroyLifetime and tests can
	// drive them via lynx.getEngine().dispatchEvent(...).
	target.lynx.getEngine = target.lynx.getNative;

	// Function-based event listeners (the testing env only implements the
	// string/worklet __AddEvent family). Stored per element so tests can
	// simulate a user gesture by invoking them.
	target.__AddEventListener = (node, name, handler) => {
		node.__vanillaListeners ??= {};
		(node.__vanillaListeners[name] ??= new Set()).add(handler);
	};

	target.__RemoveEventListener = (node, name, handler) => {
		node.__vanillaListeners?.[name]?.delete(handler);
	};

	target.__GetChildren = (node) => Array.from(node.childNodes ?? []);

	target.__ElementIsEqual = (left, right) => left === right;

	// Not implemented by the testing environment — used by gesture.js's
	// Gesture.setState(). Recorded on the element for tests to inspect.
	target.__SetGestureState = (node, id, state) => {
		node.gestureState = { id, state };
	};

	// Not implemented by the testing environment at all — used by element.js's
	// invoke(). Always succeeds, echoing back the call, so tests can assert on
	// what element.js passed through without this polyfill guessing at real
	// native success/failure semantics.
	target.__InvokeUIMethod = (_node, method, params, callback) => {
		callback({ code: 0, data: { method, params } });
		return [];
	};

	// Tree-traversal helpers the shim needs that the testing env does not provide.
	target.__GetParent = (node) => node?.parentNode ?? null;
	target.__NextElement = (node) => node?.nextSibling ?? null;
	target.__ReplaceElements = (parent, newChildren, oldChildren) => {
		for (const child of oldChildren ?? []) {
			if (child.parentNode === parent) parent.removeChild(child);
		}
		for (const child of newChildren ?? []) parent.appendChild(child);
	};

	// Record every PAPI call so tests can assert on side effects.
	for (const name of Object.getOwnPropertyNames(target)) {
		if (name.startsWith("__") && typeof target[name] === "function" && !target[name].__papiRecorded) {
			target[name] = record(name, target[name]);
		}
	}
	target.__papiCalls = papiCalls;
}
