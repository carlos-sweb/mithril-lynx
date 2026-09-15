# Live reload plan

## Resolution (2026-09-14)

**Shipped in `mithril-lynx@0.0.7`.** The plan below (Steps 1-5) was implemented
as designed and verified end-to-end on real hardware — four consecutive source
edits, each auto-reloading with no manual re-navigation. Two real bugs were
found and fixed along the way (an unresolved `assetPrefix` placeholder feeding
`new URL()`, and a resolve-alias collision that broke the client's own
import), plus a socket-lifecycle bug (every earlier reload's WebSocket was
left open, so a build a few reloads in fired `ExplorerModule.openSchema` once
per still-open stale socket and the resulting reloads raced each other) — see
the commit history for detail. (That file was deleted again in 0.0.8; the
whole in-bundle client is gone, see the second pass below.)

**New known issue, found after shipping**: each reload left the previous load's
Activity on Lynx Go's back stack. Fixed in the second pass below — shipped in
`mithril-lynx@0.0.8`.

## Resolution (second pass): the stale Activity stack

**Shipped in `mithril-lynx@0.0.8`.** `ExplorerModule.openSchema(url)` is a real
navigation, so every reload started a new `LynxViewShellActivity` and never
finished the one it replaced. The reload now goes through
`@lynx-js/devtool-connector` instead, from the Node dev-server process, and
sends CDP `Page.reload` to the session serving this app's bundle. `Page.reload`
reloads the existing page in place — the DevTools reference notes the session
URL is unchanged after it — so nothing new lands on the back stack. The
in-bundle client (`src/dev-reload-client.js`) and the synthetic background
entry it needed are both gone; entries only get a background chunk when the app
has its own `background.ts` again.

Three things worth recording, because none of them is obvious:

- **This makes adb a requirement for live reload.** The DevTool connector talks
  to the adb server (it sets up an adb reverse tunnel to the device's
  DebugRouter), so `npm run dev` and QR-scanning still work over Wi-Fi but the
  automatic reload does not. The previous `openSchema` path needed no adb at
  all — that capability was traded away deliberately, because it was the same
  mechanism that corrupted the back stack. Wireless debugging
  (`adb connect <ip>:5555`) covers this without a cable.
- **Session selection is a real correctness problem, not a detail.** Lynx Go's
  own shell page (`homepage.lynx.bundle`) is itself a Lynx session and is
  usually the newest one, and a second Lynx app or a second attached device can
  also be newer than ours. So `pickReloadTarget()` filters out non-`lynx` and
  shell sessions, prefers a session whose URL matches one of this app's
  `<entry>.bundle` names, and only then falls back to the highest
  `session_id`. It is pure and unit-tested (`test/dev-reload-target.test.ts`)
  precisely because it cannot be exercised without hardware.
- **`Page.reload` alone silently replays the PREVIOUS bundle.** This one nearly
  shipped as a "working" fix: the reload succeeded, the Activity count stayed
  flat, logcat showed a real `TemplateAssembler::LoadTemplate` and
  `onFirstScreen` — and the old text stayed on screen. The loaded template was
  byte-for-byte the previous build (52713 vs the server's 52701 — a 12-byte
  difference, exactly the length of the edited string), and `ignoreCache: true`
  did not help, which is also all the official
  `@lynx-js/webpack-dev-transport` client passes. Both the HTTP layer and Lynx's
  own bytecode cache key on the URL, so the fix is `cacheBustedUrl()`: append a
  `?t=<timestamp>` to the reload URL. The session's own URL does not change
  (verified: it still reads `.../main-thread.bundle` afterwards), so this does
  not turn the reload into a navigation.

**Verified end-to-end** on the Galaxy A07 (`adb reverse tcp:3001 tcp:3001` to
reach the dev server, bundle loaded into Lynx Go via `lynx://open?url=…`):
baseline 1 `LynxViewShellActivity`, then four consecutive source edits, each
reloading in place with the new text on screen and the Activity count still
**1** — and one Back press from the final state exits to the launcher instead
of walking back through frozen snapshots. The negative path was exercised too:
with the app closed before a rebuild, the dev server logs the "no Lynx session
found" warning and keeps building, rather than failing.

The original diagnosis is preserved below.

## Problem recap

Apps built with `mithril-lynx` (via `pluginMithrilLynx()` in `lynx.config.ts`) don't
auto-reload in the Lynx Go viewer app when source files change, even though the dev
server rebuilds correctly. React/Vue Lynx apps auto-reload fine in the *same* viewer
app on the *same* phone — this is specific to `mithril-lynx`, not the viewer.

Scope: **dev-server/bundle-URL stage only** (`npm run dev` + Lynx Go's "Bundle URL" /
QR scan), not the final native-host APK stage (`ANDROID_APK_GUIDE.md`'s later phase).

## Evidence gathered this session (real device: Galaxy device running Lynx Go
`com.funcs.io.lynx.go`, versionName `2026.06.06`, SDK 3.8.1)

1. **`mithril-lynx/plugin.js` never injected the dev-transport client into any
   entry.** Confirmed via `grep` — zero occurrences of `webpack-dev-transport` in
   the original `plugin.js`. `@lynx-js/rsbuild-plugin` (loaded transitively via
   `pluginLynxConfig`) *does* set up the aliases and `HotModuleReplacementPlugin`
   for any Lynx target, but nothing ever `import`s
   `@lynx-js/webpack-dev-transport/client` — so the compiled bundle never had a
   WebSocket client in it at all. **Fixed and confirmed**: `plugin.js` now
   synthesizes a `background` chunk in dev mode (even for apps with no
   `background.ts`, i.e. `enableBackgroundSync: false`) whose sole job is to host
   this import. Verified via `strings dist/main-thread.bundle` — before the fix,
   zero occurrences of `LynxWebSocketModule`; after, present.

2. **The dev-transport client can only run on the background/JS thread, never
   main-thread/Lepus.** Confirmed by diffing a freshly-scaffolded official React
   reference app's resolved webpack config (`rspeedy inspect`): its dev-client
   imports (`@lynx-js/webpack-dev-transport/client`, `@lynx-js/react/refresh`,
   `@rspack/core/hot/dev-server`) are **only** ever added to its `background`
   entry (`layer: 'react:background'`), never its `main-thread` entry (which only
   gets a tiny `hotModuleReplacement.lepus.cjs` CSS-hot-reload helper). This
   matches `@lynx-js/webpack-dev-transport`'s own client code, which throws
   `"WebSocket is not found. Please use Lynx >= 2.16..."` if
   `NativeModules.LynxWebSocketModule` isn't present — a Native Module, only
   reachable from a full JS engine with bridge access, which the restricted Lepus
   VM doesn't have.

3. **`mithril-lynx`'s own architecture puts ALL app view/render code on the
   main-thread/Lepus VM, never the background thread.** `background.js`'s own
   top-of-file comment: *"this side is framework-agnostic (Mithril never renders
   on the background thread in data-channel mode)"*. `main-thread.ts` directly
   imports the app's `index.ts` (the `Root` component / `view()` functions) and
   calls `setupApp({ root: app.root, ... })` — all of it compiled into the
   `main-thread` (Lepus) chunk, confirmed via `lynx.config.ts`'s
   `source.entry: { "main-thread": ... }`.

   **Consequence**: rspack/webpack's real module-level HMR (`dev.hmr: true`) can
   only ever patch modules living in the *same* module registry that ran
   `webpackHot.check()`/`.apply()` — i.e. only whatever's in the background
   chunk. Since `mithril-lynx`'s actual app code never lives there, real HMR can
   **never** patch it, no matter what's fixed elsewhere. This isn't a bug to fix,
   it's an architectural mismatch between "HMR patches the thread it's checked
   from" and "this framework's app code lives on a different thread than the one
   HMR can run on."

4. **`RuntimeWrapperWebpackPlugin` only wraps the main `background.js` bundle,
   not incrementally-emitted `*.hot-update.js` chunks.** Confirmed by turning
   `dev.hmr` on (with the dev-client wired per #1) and editing source: native
   logs `NativeError: eval external js script failed! ... ReferenceError: exports
   is not defined ... main-thread__background.<hash>.hot-update.js:30:1`. Even if
   this were fixed, #3 means it would only ever patch the (empty, synthetic)
   background chunk — not the app.

5. **`LynxDevToolSetModule.invokeCdp('Page.reload')` — the "automatic native
   fallback" `@lynx-js/webpack-dev-transport`'s own `reloadApp.js` uses when
   `dev.hmr: false` / `dev.liveReload: true` — does not work on this Lynx Go
   build.** Confirmed: with `dev.hmr` forced off, the client correctly logged
   `"Server started: Hot Module Replacement disabled, Live Reloading enabled..."`,
   connected via `LynxWebSocketModule.connect`, and on a source edit correctly
   invoked `LynxDevToolSetModule.invokeCdp.{"method":"Page.reload",...}` — but no
   visible reload followed, and no `PageReloadHelper.loadFromURL` log line
   appeared afterward either (contrast with real navigations, which always log
   that line). The native call appears to be a no-op without an attached
   external CDP/DevTools session.

6. **The *same* Lynx Go app reloads a React reference app (freshly scaffolded via
   `create-rspeedy -t rspeedy-react-ts`) successfully, via real module HMR —
   *not* `Page.reload`.** Editing `src/App.tsx` and watching logcat: `"[HMR]
   Checking for updates..."` → fetches and evaluates
   `main.<hash>.hot-update.js` cleanly (no "exports is not defined" — its
   background chunk *is* correctly wrapped) → `"[HMR] Updated modules: -
   (react:background)/./src/App.tsx"` → `"[HMR] App is up to date."` — **no
   `invokeCdp` call anywhere in the sequence.** Screenshot confirms the visible
   text updated in place, no re-navigation. This is powered by
   `@lynx-js/react`'s own React-Refresh integration reacting to the applied hot
   module — i.e. real HMR *does* work on this device/app, it's just that it can
   only ever reach code running on the background thread, which is where
   ReactLynx (unlike `mithril-lynx`) actually puts the app's component code.

7. **`NativeModules.ExplorerModule.openSchema(url)` reliably performs a full
   reload when called directly.** This is the exact native call Lynx Go's own UI
   makes when the user taps a "Recently Opened" row or presses "Go" after typing
   a URL — confirmed multiple times via logcat
   (`MethodInvoker::InvokeMethod, method: (ExplorerModule.openSchema.<url>)`)
   immediately followed by a real, visible reload of the target bundle. This is
   almost certainly the mechanism the "explorer app already handles this, we
   just need to accept it" intuition (from earlier in this investigation) was
   actually pointing at — just not through the CDP path.

## Root cause, in one sentence

`mithril-lynx` apps have no code running on the background thread by design,
real HMR can only patch the background thread, and this Lynx Go build's CDP-based
`Page.reload` fallback (the *other* mechanism `@lynx-js/webpack-dev-transport`
knows how to trigger) doesn't actually do anything — so neither of the two reload
strategies `@lynx-js/webpack-dev-transport` supports out of the box can work here;
a third, `mithril-lynx`-specific strategy is needed, using the one native reload
path we've confirmed *does* work: `ExplorerModule.openSchema`.

## Plan

### Step 1 — Confirm `ExplorerModule` is reachable from a *guest* bundle's background thread

So far `ExplorerModule.openSchema` has only been observed being called from Lynx
Go's own `homepage.lynx.bundle` (its UI shell). Native Modules are normally
registered at the SDK/LynxView level and available to whatever bundle is
currently loaded, but this needs to be verified, not assumed, before building on
it. In the synthetic background chunk `plugin.js` already creates for dev builds,
temporarily add:

```js
console.log("[dev-reload] ExplorerModule available:", typeof NativeModules?.ExplorerModule?.openSchema);
```

Load the mithril-lynx dev bundle and check logcat / the on-device console
overlay. If `ExplorerModule` isn't there, this whole plan needs a different
native entry point (see "Open questions" below) — stop and re-scope before
Step 2.

### Step 2 — Determine how to get the current bundle URL at runtime

`openSchema(url)` needs the *same* URL the app was loaded from (the dev-server
URL, e.g. `http://10.182.187.27:3000/main-thread.bundle`) to reload against.
Options, cheapest first:

- Bake it in at **build time**, the same way `@lynx-js/rsbuild-plugin` already
  bakes `hostname`/`port`/`token` into `@lynx-js/webpack-dev-transport/client`'s
  resolved path as a query string (see `plugin.js`'s reading of
  `environment.config.dev?.client`). `pluginMithrilLynx()` can compute the same
  `http://<hostname>:<port>/<bundle-filename>` URL it already knows (`filename:
  "[name].bundle"` from the user's own `output.filename` config) and pass it to
  the new dev-reload-client module via its own query string or a
  `DefinePlugin`/`ProvidePlugin` constant.
- Fallback if that's unreliable in practice (e.g. `assetPrefix`/proxy setups):
  check whether `lynx.__globalProps` or an equivalent runtime global exposes the
  loading URL — needs empirical confirmation on-device, don't assume the API
  exists.

### Step 3 — Write `mithril-lynx`'s own minimal dev-reload client

New file, e.g. `mithril-lynx/src/dev-reload-client.js` (only ever imported in dev
builds, never shipped to production). Responsibilities, deliberately narrow:

- Open a WebSocket to the *same* `/rsbuild-hmr` endpoint the stock client uses
  (`ws://<hostname>:<port>/rsbuild-hmr?token=...`) — reuse
  `createSocketURL`/`socket` from `@lynx-js/webpack-dev-transport/lib/client/` if
  they're reachable as a subpath import; otherwise a ~20-line reimplementation
  using the already-confirmed-available `NativeModules.LynxWebSocketModule` (see
  evidence #2) is fine — this doesn't need the general-purpose client's
  hot/liveReload branching at all.
- On an `"ok"` message (a successful rebuild with no errors — the same signal
  the stock client's `reloadApp()` reacts to), call
  `NativeModules.ExplorerModule.openSchema(bundleUrl)` directly. No `check()`,
  no `apply()`, no hot-update chunk fetching at all.
- Keep `"still-ok"`/`"errors"`/`"warnings"` handling minimal (log to console via
  `lynx.reportError`/`console.warn`, don't reload on errors) — mirroring the
  stock client's intent without its hot-module machinery.

### Step 4 — Wire it into `plugin.js`

- Replace the `DEV_CLIENT_IMPORTS` constant's `@lynx-js/webpack-dev-transport/client`
  entry with the new `dev-reload-client.js` (resolved to its real path the same
  way `mithril-lynx`'s own alias-setting code already resolves its own package
  root — see the existing `packageRootOf()` helper).
- Keep the `includeBackground` synthetic-background-chunk logic exactly as-is —
  the new client still needs to run on the background thread (evidence #2).
- Keep forcing `dev.hmr: false` (already done) — real HMR is architecturally
  moot per evidence #3/#6, and turning it off avoids `RuntimeWrapperWebpackPlugin`'s
  hot-update-chunk gap (#4) entirely rather than fixing it for no benefit.
  `dev.liveReload` stays at its default (`true`) — harmless, even though the new
  client doesn't read it, in case anything else in the chain checks it.
- No `@rspack/core/hot/dev-server` import needed at all now (nothing left that
  listens for `webpackHotUpdate` events).

### Step 5 — End-to-end verification (repeat this session's exact protocol)

On the real device: load the dev bundle via Lynx Go (QR scan — manual URL entry
via `adb input` proved unreliable this session and isn't a good test signal
either way), edit `src/index.ts`'s visible text, wait, screenshot **without
touching the phone**. Confirm the new text appears with no manual re-navigation.
Also verify a normal `npm run dev` → Ctrl-C → restart cycle still works (the
Step 1 test file should be removed/gated behind dev-only before shipping).

### Step 6 (only if Step 1 fails) — Re-scope

If `ExplorerModule` turns out not to be reachable from guest bundles, this
specific approach doesn't work and needs re-investigation — worth checking
whether Lynx Go exposes *any* other Native Module for "reload current page from
a URL" (grep an unpacked APK / `lynx-devtool`'s own source for `NativeModule`
registrations), since `invokeCdp('Page.reload')` is confirmed dead-end (#5).

## Open questions / risks

- **`ExplorerModule` is Explorer/Lynx-Go-specific, not a guaranteed-present SDK
  API.** A different viewer app (or the final native-host APK stage, explicitly
  out of scope per the user) may not have it at all. This plan only targets "the
  dev-server + Lynx Go viewer" stage the user is actually in right now — worth
  documenting clearly in `mithril-lynx`'s own docs as a known, deliberate
  limitation rather than a universal guarantee.
- Haven't confirmed whether `invokeCdp('Page.reload')`'s no-op is specific to
  this Lynx Go build/version, or the CDP command itself needs a differently-shaped
  payload/an attached session first. Not pursued further since #7 already gives
  a working path, but worth a one-line note if this plan is revisited later.
- Step 2's "bake the bundle URL in at build time" needs to keep working when a
  user overrides `output.filename` or serves behind a proxy/`assetPrefix` — worth
  a quick sanity check against `pluginQRCode`'s own URL-construction logic
  (already in this same file, already handles this correctly for the QR flow).

## Resolved: stale Activity stack on Back

**Status: fixed in `mithril-lynx@0.0.8`** — see "Resolution (second pass)"
above for the mechanism. The diagnosis below is kept as the record of how it
was traced; the "Not yet tried" list at the end is what the fix ended up
resolving, by removing `openSchema` from the picture entirely rather than by
finding a flag to stop it stacking.

**Symptom** (reported by the user after the live-reload fix above shipped and
was verified working): the reload itself is correct — the visible content
always ends up matching the latest source edit — but the *previous* bundle
load is never torn down. Pressing the phone's Back button doesn't return to
Lynx Go's scan/URL-entry home screen the way it does after a single normal
load; it steps back through one stale, frozen snapshot of the app per
previous reload before eventually reaching home.

**Evidence gathered** (same real device, `adb shell dumpsys activity
activities`):

- After the *initial* QR-scan load (before any edits), the task already
  contains **two** stacked `LynxViewShellActivity` instances (`Hist #0`,
  `Hist #1`) — the QR-scan flow itself is not activity-count-neutral, likely
  one for the scanner UI and one for the loaded bundle, though this wasn't
  investigated further.
- After one source edit (one live-reload cycle), the stack grew to **four**
  instances (`Hist #0`-`#3`) — two more `LynxViewShellActivity` entries added
  for a single reload.
- After a second edit, the stack grew to **five** (`Hist #0`-`#4`) — one more
  entry this time. (Growing by 2 then by 1 across two otherwise-identical
  reloads is itself unexplained — not investigated further; possibly a
  one-off from the QR-scan flow's own activity, or a timing-dependent Explorer
  behavior.)
- Pressing Back once from the "five" state landed on a screen showing
  `PRUEBA 12 - reload 5` — the exact text set two edits earlier, i.e. a
  genuinely frozen prior `LynxView` instance, not the home screen.

**Likely cause (not yet confirmed against Lynx Go's own source)**: earlier in
this investigation, starting Lynx Go's `LynxViewShellActivity` via `adb shell
am start` was observed in logcat with the `LAUNCH_MULTIPLE` intent flag
(`flg=0x10000000`) and an `ActivityManager` result of `START_TASK_TO_FRONT`
(`result code=3`) rather than `START_SUCCESS`. If `ExplorerModule.openSchema`
starts its new `LynxViewShellActivity` the same way — `LAUNCH_MULTIPLE`, no
`FLAG_ACTIVITY_CLEAR_TOP`, and never calling `finish()` on the activity making
the call — every reload would push a new instance onto the back stack by
design, exactly matching what's observed. This would be **native, Lynx-Go-side
behavior**, not something `mithril-lynx`'s own JS code controls — the
dev-reload-client only ever calls `NativeModules.ExplorerModule.openSchema(url)`
once per successful rebuild (confirmed separately: exactly one `openSchema`
call per edit, no duplicate-fire — see the socket-lifecycle fix above), so the
stacking is happening entirely on the native side of that call, not from a
duplicate JS-side invocation.

**Not yet tried**:
- Grep Lynx Go's own APK / `lynx-devtool`'s source for `ExplorerModule`'s
  actual Android implementation, to confirm the `LAUNCH_MULTIPLE`/no-`finish()`
  hypothesis rather than assuming it.
- Check whether `ExplorerModule` exposes a second method, or an options
  argument to `openSchema`, that replaces the current activity instead of
  stacking a new one (e.g. something equivalent to
  `FLAG_ACTIVITY_CLEAR_TOP`/`FLAG_ACTIVITY_SINGLE_TOP`).
- If no such option exists, whether some *other* Native Module call
  (available from JS) can `finish()` the activity that's about to be replaced
  — called right before `openSchema`, from `dev-reload-client.js`.
- Whether this is specific to this Lynx Go build/version, or true of the
  official viewer generally.

**Impact / workaround for now**: purely a dev-session ergonomics issue, not a
correctness bug — the app always shows current content, and the stacked
activities are cheap frozen views, not leaking sockets or timers (each old
bundle's own dev-reload-client already closed its own socket before the
reload that superseded it, per the fix above). Users doing many edits in one
session should be aware Back will step through several stale screens before
reaching Lynx Go's home screen, and can use "recent apps" → close, or
force-stop the app, to reset the stack instead.
