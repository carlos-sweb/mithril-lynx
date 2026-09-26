# `mithril-lynx/route` — contract and parity analysis

Date: 2026-09-25. Scope: `src/route.js` (mithril-lynx 3.0.0, unpublished;
identical route code to 2.6.2) against Mithril 2.3.8's `api/router.js`, the
official Lynx documentation (`lynxjs.org/llms-full.txt`, read in full for
navigation topics), and its use in the `non-contact` production app.

Every "Verified" claim below was checked by running code against the real
`route.js` (a throwaway test through `@lynx-js/testing-environment`), not by
reading it. Claims about Lynx come from the official docs and are cited by
page.

## 0. Status after the fixes (commit 63fbedd)

Everything in section 4 marked ❌ or ⚠️ that isn't an intentional
difference is fixed, each with a test in `test/route.test.ts` that fails on
the previous `route.js`:

| Item | Now |
|---|---|
| Redirect during a render throws | fixed — resolution deferred to a microtask, coalesced |
| `:key` change doesn't remount | fixed — keyed fragment, as upstream |
| `route.Link` runs lifecycle hooks twice | fixed — `censor` (upstream util) strips `key` + hooks |
| `route.Link` ignores `preventDefault()` / `{ handleEvent }` | fixed (forwarded events now record `defaultPrevented`) |
| `options.state` ignored | fixed — stored per entry, merged into params, restored by back/forward |
| Param-name separator check missing | fixed — same `SyntaxError` as upstream |
| `null` default route → TypeError from inside | now a clear `TypeError`; intentional (no URL to start from) |
| `get()` returns the encoded path | fixed — decoded, as upstream |
| `set()` is synchronous | now asynchronous, as upstream (**breaking**, documented in `ROUTE.md`) |
| Android back button | `route.canGoBack()` + opt-in `route.listenBackButton()`; host recipe in `ROUTE.md` |

Still open: deep links (5.2), the `non-contact` host integration (5.1),
and a device check of the asynchronous `set()` and the back button.

The rest of this document is the analysis as written before the fixes.

## 1. Verdict

- **The model is right.** Lynx has no browser History API and no
  navigation in its core. ReactLynx's two documented routers use exactly the
  same in-memory approach as `mithril-lynx/route` (React Router's
  `MemoryRouter`, TanStack Router's `createMemoryHistory`).
- **API parity with `m.route` is high but not complete:** 3 real bugs
  (redirect during a render throws, a changed `:key` doesn't remount the
  page, `route.Link` runs lifecycle hooks twice), 3 missing pieces
  (`options.state`, `null` default route, param-name check) and 4 behavior
  differences that aren't documented (section 4).
- **The Lynx integration has gaps:** the Android back button isn't wired
  (in `non-contact`, back most likely closes the app), deep links from the
  host aren't supported, and `ROUTE.md` states two things about Lynx that
  the docs contradict (section 5).

## 2. How navigation works in Lynx

From the official docs:

| Topic | What Lynx provides | Source |
|---|---|---|
| Native navigation in the core | **None.** Native navigation is delegated to "app frameworks"; the 2025 roadmap listed "native navigation" as future app-level work. | `/guide/start/build-with-app-framework.md`, `/blog/lynx-open-source-roadmap-2025.md` |
| Official app framework | **Sparkling** (TikTok): "scheme-driven multi-page routing". Each page is its own Lynx container; `open({ scheme: "hybrid://lynxview_page?bundle=…" })`, `navigate({ path, options: { params } })`, `close()` from `sparkling-navigation`. Params reach the page through initData/globalProps. | `/blog/lynx-open-source-roadmap-2026.md`, tiktok.github.io/sparkling (APIs → Navigation, Scheme) |
| Routing inside a page (ReactLynx) | React Router v6 with `MemoryRouter`; TanStack Router with `createMemoryHistory` ("required due to browser History API limitations in Lynx"). Neither has a `<Link>` in Lynx: you navigate from `bindtap`. | `/react/routing/react-router.md`, `/react/routing/tanstack-router.md` |
| Host → page data | `initData` at `LynxView.loadTemplate()`, updates via `updateData()`; `lynx.__globalProps` + `onGlobalPropsChanged`. | `/guide/use-data-from-host-platform.md`, `/api/lynx-api/lynx/lynx-global-props.md` |
| Host → page events | `LynxView/LynxContext.sendGlobalEvent(name, params)` → JS `lynx.getJSModule("GlobalEventEmitter").addListener(name, …)`. | `/api/lynx-native-api/lynx-view/send-global-event.md`, `/guide/interaction/event-handling/event-propagation.md` |
| Back button reaching JS | Only inside an `<overlay>`: `bindrequestclose` — "Callback when the back button is clicked" (Android, Desktop, Harmony; Lynx 3.5). No general back-button event. | `/api/elements/built-in/overlay.md` |

So there are two navigation models on Lynx:

1. **In-page routing** — one page, one LynxView; screens are swapped inside
   it by a memory router. This is what ReactLynx's routers and
   `mithril-lynx/route` do.
2. **Multi-page native navigation** — one container per screen, a native
   stack, a real system back gesture (Sparkling). Each page is a separate
   bundle entry, and data travels as initData/globalProps.

`mithril-lynx/route` implements model 1, the same one as ReactLynx. Model 2
lives in the host app/framework, not in the JS router; mithril-lynx works
inside such pages unchanged (each page is its own `renderApp()`).

## 3. What `m.route` is (the reference)

Mithril 2.3.8 `api/router.js`, 243 lines: `route(root, defaultRoute, routes)`,
`route.set(path, data, options)`, `route.get()`, `route.param(key)`,
`route.prefix`, `route.Link`, `route.SKIP`, route resolvers
(`onmatch`/`render`), resolution deferred with `setTimeout` on `set` and
`popstate`, and `history.state` merged into params.

## 4. Parity table

✅ same behavior · ⚠️ differs · ❌ missing or broken.

### Setup — `route(…)`

| Aspect | `m.route` | `mithril-lynx/route` | Status |
|---|---|---|---|
| Signature | `route(root, defaultRoute, routes)` | `route(defaultRoute, routes)` — no `root`; mounts through its own `renderApp()` | ⚠️ intentional, documented |
| Routes must start with `/` | SyntaxError | same | ✅ |
| Param-name separator check (`/:a:b`) | SyntaxError "Route parameter names must be separated with either '/', '.', or '-'." | **accepted** (verified) | ❌ missing check |
| Default route must match a route | ReferenceError | same | ✅ |
| `defaultRoute` may be `null` | allowed (skips the check) | **TypeError** "Cannot read properties of null" (verified) | ❌ |
| Calling it again (re-registration) | re-registers and re-resolves the browser URL | re-resolves the **current** path, keeps history (HMR support) | ⚠️ intentional improvement, documented in code |
| Teardown when the router unmounts | `RouterRoot.onremove` resets state | none (one `renderApp()` per app lifetime) | ⚠️ intentional |

### Resolution

| Aspect | `m.route` | `mithril-lynx/route` | Status |
|---|---|---|---|
| Timing | `set()` schedules resolution (`setTimeout`); several `set()`s in a row coalesce | **synchronous**: `get()` returns the new path right after `set()` (verified) | ⚠️ undocumented |
| Redirect during a render (e.g. `route.set("/login")` in a page's `oninit`) | works (deferred) | **throws** "Node is currently being rendered to and thus is locked." (verified) | ❌ **bug** |
| Resolvers: `onmatch` (sync or promise), `render`, `SKIP` fallthrough | yes | same | ✅ |
| `route.set` while an `onmatch` is pending → forced `replace` | yes | same | ✅ |
| `onmatch` rejection → `console.error` + fallback with replace | yes | same | ✅ |
| Unmatched path → fallback with replace; unmatched default → Error | yes | same | ✅ |
| Component fallback when `onmatch` returns nothing | `"div"` | `"view"` | ✅ (Lynx equivalent) |
| Remount when the matched component stays but a `:key` param changes | yes — `Vnode(component, attrs.key, attrs)` wrapped in a fragment "to preserve existing key semantics" | **no** — same instance kept, state persists (verified) | ❌ **bug** |
| Path decoding | whole path decoded before matching | params decoded (verified `"a b/c"`), but `get()` returns the encoded path `"/d/a%20b%2Fc"` (verified) | ⚠️ |
| Query string → params (with `"true"`/`"false"` coercion) | yes | same (verified) | ✅ |

### Navigation — `route.set / get / param`

| Aspect | `m.route` | `mithril-lynx/route` | Status |
|---|---|---|---|
| `set(path, data)` interpolation via `buildPathname` | yes | same | ✅ |
| `options.replace` | `replaceState` | overwrites the current history entry | ✅ |
| `options.state` | stored in `history.state`, merged into params, restored on back/forward | **ignored** (verified) | ❌ missing |
| `options.title` | passed to `pushState` (browsers mostly ignore it) | ignored | ✅ (no-op on Lynx is fine) |
| `set()` before `route()` | `location.href = …` | throws a clear error | ⚠️ intentional, documented |
| Same path pushed twice | two history entries | same (verified) | ✅ |
| `get()` | current path | same (encoded, see above) | ✅/⚠️ |
| `param(key)` / `param()` | yes | same | ✅ |
| `prefix` | `"#!"`, used in URLs | `""`, no effect | ⚠️ intentional, documented |

### `route.Link`

| Aspect | `m.route` | `mithril-lynx/route` | Status |
|---|---|---|---|
| Default element | `a` | `view` | ✅ (Lynx equivalent) |
| Trigger | `onclick` (+ modifier-key / non-left-click checks) | `ontap` | ✅ (Lynx equivalent) — apps porting `onclick` on a Link must rename it |
| Lifecycle hooks and `key` in the Link's attrs | removed before rendering the child (`censor`: `key`, `oninit`, `oncreate`, `onbeforeupdate`, `onupdate`, `onbeforeremove`, `onremove`) | **passed to the child too**: `oncreate` ran **twice** (verified) | ❌ **bug** |
| Handler returning `false` cancels navigation | yes | yes | ✅ |
| Handler calling `preventDefault()` cancels navigation | yes (`e.defaultPrevented`) | no | ⚠️ |
| EventListener object (`{ handleEvent }`) as handler | supported | not supported | ⚠️ |
| `disabled` | no handler, `href` removed, `aria-disabled` | no handler; `disabled` passed through | ✅ |
| `params` / `options` | yes | yes | ✅ |

### Not in `m.route` (mithril-lynx additions)

| Addition | Purpose | Status |
|---|---|---|
| `route.back()` / `route.forward()` returning `boolean` | walk the in-memory history (no browser back) | ✅ works; see 5.1 for the missing hardware-back wiring |
| HMR re-registration keeps the current path and history | hot reload without losing the screen | ✅ used by `non-contact` (`route.set(route.get(), null, { replace: true })`) |

## 5. Gaps against what Lynx and the host offer

### 5.1 Android back button

- `ROUTE.md` says "Lynx has no hardware/gesture back button exposed to JS".
  That's incomplete: `<overlay>` has `bindrequestclose` (overlays only), and
  any host can forward the back key to JS with `sendGlobalEvent` →
  `GlobalEventEmitter` — `non-contact` already uses that exact channel for
  its QR scanner (`NonContactScannerModule.kt` → `scanResult`).
- **`non-contact`:** `MainActivity` is a plain `AppCompatActivity` with no
  back handling. Android's default then finishes the activity, so pressing
  back on "Países" or "Historial" **closes the app** instead of returning to
  the dialer — confirmed on the device by the app's owner.
- **Missing piece:** a documented, tested recipe (or a small helper) —
  host intercepts back (`OnBackPressedCallback`), sends a global event, JS
  calls `route.back()`, and if that returns `false` asks the host to finish
  (a NativeModule method).

### 5.2 Deep links / initial route from the host

- `ROUTE.md` says "nothing external can set the initial path — it's always
  `defaultRoute`". The host *can* pass data (`initData` on `loadTemplate`,
  `updateData` later, `globalProps`); what's missing is support in `route`
  for reading an initial path from it. `main-thread.js` already registers a
  pass-through `processData`, so initData reaches the page.
- **Open question:** how the background thread reads initData without
  ReactLynx (ReactLynx keeps it in `lynx.__initData`); needs checking on a
  device before designing the API.

### 5.3 Multi-page native navigation

Out of scope for the router by design (section 2). A Sparkling-style host
can load several mithril-lynx pages; no change needed, but it isn't
documented or tested.

### 5.4 Page teardown log noise

Navigating between screens logs a burst of
`DestroyLayoutNodeBeforeRemoveFromParent` errors (non-fatal). It happens
with 2.6.2 as well (64 lines on dialer → countries), so it isn't caused by
the 3.0.0 changes. It comes from the renderer removing a whole screen
subtree, not from `route.js` itself. Not investigated.

## 6. Recommendations

In priority order:

1. **Fix the render-time redirect bug:** resolve `route.set()` outside the
   current render (defer it, as upstream does), at least when called during
   a render. Add a test with the `oninit` guard pattern.
2. **Fix `route.Link`** to strip `key` and lifecycle hooks from the child's
   attrs (upstream `censor` set); honor `e.defaultPrevented`.
3. **Restore key semantics:** render the matched component as
   `[m(component, attrs)]` so a changed `:key` param remounts it.
4. **Implement `options.state`:** store it with each history entry, merge it
   into params, and restore it on `back()`/`forward()`.
5. **Small parity items:** param-name separator check, `null` default
   route, and a decoded `route.get()` — or document them as deliberate.
6. **Back button:** ship the host recipe (5.1), then fix `non-contact`
   after confirming the current behavior on the device.
7. **Deep links:** verify how initData is read on the background thread,
   then add an opt-in initial path (e.g. `route(defaultRoute, routes,
   { initialPath })`).
8. **Correct `ROUTE.md`** (back button, deep links) and list the remaining
   intentional differences in one place.

## 7. Verification plan

- Unit tests for items 1–5 through `@lynx-js/testing-environment`, following
  `test/route.test.ts` (the probes used for this analysis can be turned into
  them directly).
- On a device: the render-time redirect, hardware back in `non-contact`
  (before and after the fix), and a deep link via initData.
