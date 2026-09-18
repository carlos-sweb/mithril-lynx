// test/setup.ts
//
// This package's own tests use the exact same polyfill it now publishes
// for everyone else (src/testing.js's installTestingPolyfills) — see that
// file's header for what it covers and why.

import { installTestingPolyfills } from "../src/testing.js";

globalThis.onInjectMainThreadGlobals = installTestingPolyfills;
