// Ambient declaration for the ESM testing.js (the file itself is not
// type-checked; this describes its runtime export shape for TS consumers).

/**
 * Installs the @lynx-js/testing-environment PAPI polyfill mithril-lynx apps
 * need for their own tests. Assign to
 * globalThis.onInjectMainThreadGlobals in a test setup file. See the
 * project plan, Phase 9.
 */
export function installTestingPolyfills(target: any): void;
