// test/setup.ts
//
// Delegates to ../testing.js's installTestingPolyfills — the same helper
// published as mithril-lynx/testing for consuming apps' own tests (see the
// project plan, Phase 9). Kept as a package-local relative import here
// rather than the public subpath, but otherwise identical to how
// mithril-app/test/setup.ts uses it.

import { installTestingPolyfills } from "../testing.js";

globalThis.onInjectMainThreadGlobals = installTestingPolyfills;
