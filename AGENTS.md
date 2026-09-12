# AGENTS.md

Guidance for AI agents working in this repo (`mithril-lynx` core). Read this
before writing or debugging shim/render code, or code in any consuming app.

## Runtime constraint: the Lynx main-thread JS engine is QuickJS, not V8

Every consuming app's main-thread code runs inside Lynx's main-thread JS
engine, which is QuickJS-based — not a browser or Node.js engine. Full
coverage under `@lynx-js/testing-environment`'s jsdom polyfill (Node's V8) or
in editor tooling does NOT mean an API exists on the real device.

**Confirmed missing: `Array.prototype.at()`** (ES2022) — throws a generic
`TypeError: not a function`, with a native backtrace that gives almost no
clue it's an API-support gap rather than a shim/framework bug. Since it only
fails once an array actually has content, it can look like a much bigger,
unrelated regression (a whole page's interactivity appearing to break) than
it actually is. See this repo's README, "Compat with the plain-JS ecosystem"
section, and `mithril-lynx-ui`'s own `AGENTS.md`/`sortable.js` header for the
full story of two real crashes this caused there.

Use `arr[arr.length - 1]` instead of `arr.at(-1)`. `.slice(-N)` (pre-ES2022,
negative index) is fine. Before relying on any other newer Array/Object/
String method, verify it against a real device build — the jsdom test suite
will not catch this class of gap.

## Verifying on a real device

See `DEVICE_VERIFICATION.md` for the established workflow (build, install to
a consuming Android app, `adb logcat`/`adb shell input` for interaction and
error capture) and the log of what's already been confirmed working versus
what's still theoretical.
