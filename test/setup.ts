// test/setup.ts
//
// This package's own tests use the exact same polyfill it now publishes
// for everyone else (src/testing.js's installTestingPolyfills) — see that
// file's header for what it covers and why.

import { afterEach } from "@rstest/core";
import { installTestingPolyfills } from "../src/testing.js";
import { unregister } from "../src/mount-redraw.js";

globalThis.onInjectMainThreadGlobals = installTestingPolyfills;

// mount-redraw.js is a single-slot singleton and register() now fails fast
// on a second registration (R2) — clear it between tests so each test's own
// renderApp() starts from a clean slate instead of colliding with the
// previous test's still-registered redraw.
afterEach(() => {
	unregister();
});
