# mithril-lynx

Mithril.js rendered through [Lynx](https://lynxjs.org)'s Element PAPI, with genuine automatic redraw and three real reload modes — the two things the previous version of this project never fully got right.

> **Note:** this is a complete, from-scratch rewrite of the previous `mithril-lynx` (internally, "v2") — not an incremental patch on top of it. The old implementation is retired; no more fixes land against that design. See "Why a rewrite" below for exactly what justified starting over instead of patching it again.

## What's new in 3.0.0

- **Native `<list>` / `<list-item>` as ordinary Mithril elements** — keyed items, every attribute with its real type, attached on demand by native. Breaking: replaces `Op.CreateList`/`Op.SetListItems` and the `list-cell`/`list-support` entry points. See below.
- **`<input>` / `<textarea>` like on the web** — `value`, `autofocus`, and `vnode.dom.focus()`/`blur()`/`invoke(method, params)` for any element's native UI methods, with no `id`, `setTimeout` or selector query. See [`INPUT.md`](./INPUT.md).
- **`route` parity with Mithril's `m.route`** — asynchronous `set()`, `options.state`, `:key` remounts, `route.Link` fixes, plus `canGoBack()` and an opt-in Android back button (`listenBackButton()`). Breaking: `set()` now resolves on the next microtask. See [`ROUTE.md`](./ROUTE.md).
- Leak fixes, render coalescing for high-frequency events, and a style-clear fix.

Full list: [`CHANGELOG.md`](./CHANGELOG.md). The main-thread and background bundles must be rebuilt together (patch protocol `0x4d4e`).

## Why a rewrite

The old implementation's core bugs all traced back to the same root cause: whether a redraw actually reached the main thread depended on runtime conditions (`typeof globalThis.__FlushElementTree === "function"`, which render mode was active, load order) instead of a fixed contract. Every fix added another conditional on top of the last one. Reading ReactLynx's own source (not just its docs) showed its actual patch-channel/reload design is a different architecture, not an incremental improvement on the old one — so this rewrite starts over with that contract from the first commit:

- **One thread model, not three.** The old version had main-thread-owned, data-channel, and renderer modes. This one has exactly one: the real `mithril/render/render.js` (via [`mithril-runtime`](https://github.com/carlos-sweb/mithril-runtime)) always runs on the **background** thread against a virtual tree; the **main thread** only ever replays patches onto real Element PAPI nodes and forwards native events back. No app view code ever runs on the main thread.
- **One explicit commit hook, not a conditional global.** `src/commit.js` installs exactly one commit callback per `renderApp()` lifetime, set up once by the code that owns the render. Asking to commit before one is installed throws immediately, on the same tick, with a message naming exactly what's missing — never a silently frozen screen.
- **Three reload modes, correctly separated** (the full device-verified story is in the rewrite plan — see "Reference docs"):
  - **A — data reload**: text/props/CSS edits. Already validated in the old version; rebuilt on the new core.
  - **B — structural reload**: adding/removing/reordering tree nodes. The old version assumed this *had* to be a full reload; this one lets Mithril's own real diff (running in the background against a real tree) produce the right Create/Insert/Remove ops instead — no separate wire-protocol mode needed, just reconciliation that doesn't discard nodes that didn't change.
  - **C — full reload**: fallback for what A/B can't resolve (new imports, changed dependencies, an unrecoverable error). Same CDP `Page.reload` mechanism stabilized in the old version's 0.0.9, rewritten on the new core.

**Carried over as code, not yet device-verified**: gestures (`src/apply-patch.js`'s `Op.SetGestureDetector`). The new arena-claim gesture path is explicitly unverified on a real device (see the note in `apply-patch.js`). The native `<list>` below is device-verified.

**Native `<list>` (3.0.0+)**: `list` and `list-item` are ordinary Mithril elements — render them like any other, key the items, and Mithril's own keyed diff drives the native list:

```js
m("list", { "list-type": "single", "span-count": 1, "scroll-orientation": "vertical",
            "lower-threshold-item-count": 2, onscrolltolower: loadMore },
  items.map((it) => m("list-item", { key: it.id, "item-key": it.id }, row(it))))
```

Every documented `<list>` attribute (`bounces`, `item-snap`, `sticky`, `update-animation`, …) and `<list-item>` attribute (`full-span`, `sticky-top`/`-bottom`, `estimated-main-axis-size-px`, `reuse-identifier`, `recyclable`) is passed with its real type — booleans and objects included (`src/list-attributes.js` is the catalog). Events use the usual `on*` attrs (`onscroll`, `onscrolltoupper`, `onscrolltolower`, `onscrollstatechange`, `onlayoutcomplete`, `onsnap`); methods (`scrollToPosition`, `scrollBy`, `autoScroll`, `getVisibleCells`) are called with `vnode.dom.invoke(method, params)` (see "Forms and native element methods"), or a selector query on the list's `id`. `item-key` must be unique and stable — use the same value as `key`. **Known gap:** `update-animation="default"` is not safe yet on lists that remove on-screen items — see [`UPDATE_ANIMATION_GAP.md`](./UPDATE_ANIMATION_GAP.md). The main-thread side (`src/list-runtime.js`) follows @lynx-js/react's element-template list: each item keeps its own element tree and is attached only when native asks for it. 3.0.0 removes the previous `Op.CreateList`/`Op.SetListItems` protocol and the `mithril-lynx/list-cell` / `mithril-lynx/list-support` entry points. **Deliberately not carried over at all (yet)**: the old stack-based `navigation` module (in-memory `route` plus the opt-in Android back button cover navigation — see [`ROUTE.md`](./ROUTE.md)); v1's imperative ref helpers are replaced by `vnode.dom.invoke()`/`focus()`/`blur()`. Those were real, device-verified capabilities in v1 — this rewrite's scope so far is specifically the redraw/reload core plus routing and networking (see below). Reimplementing the rest on this core is future work, not something this rewrite claims to already cover.

## Usage

`main-thread.ts`:

```js
import { setupRenderer } from "mithril-lynx/main-thread";

setupRenderer();
```

`background.ts`:

```js
import { renderApp } from "mithril-lynx/background";
import m from "mithril-runtime";

let count = 0;
const Counter = {
  view: () => m("text", { ontap: () => { count += 1; } }, String(count)),
};

renderApp({ root: () => m(Counter) });
```

`setupRenderer()` needs no app-specific code — it's generic, wired once via `mithril-lynx/plugin` (the Rspeedy/Rsbuild plugin building the two-bundle main-thread/background app). All app logic, including the whole Mithril component tree, lives in `background.ts`. A tap handler that mutates state repaints the screen with **no explicit `redraw()` call anywhere in the view** — real Mithril's own `render(dom, vnodes, redraw)` contract does that automatically after any event, the same mechanism `@lynx-js/react` relies on (see `test/end-to-end.test.ts` for this exact scenario running against real Lynx PAPI via `@lynx-js/testing-environment`, not a mock).

`mithril-runtime` — not the official `mithril` package — is the `peerDependency` here: a maintained fork with `m.route`/`m.trust`/`m.request` stripped at the source (see its own README for why), since those three need Lynx-specific replacements anyway (routing and networking below; `m.trust` has no replacement — see "Known gaps").

## Routing

`m.route`, reimplemented as in-memory history (Lynx has no URL/`window.history` for a real one to hook into) while keeping the rest of the real `m.route` API shape. See [`ROUTE.md`](./ROUTE.md) for the full API and usage.

## Networking

`m.request`, reimplemented as a wrapper over Lynx's own `fetch`. See [`REQUEST.md`](./REQUEST.md) for the full API, and [`FETCH_INVESTIGATION.md`](./FETCH_INVESTIGATION.md) for the complete option-by-option gap analysis against the real `m.request` spec, backed by real-device evidence rather than docs/types alone (which were wrong twice during that investigation).

## Forms and native element methods

`m("input", { value, autofocus: true, oninput })` works as on the web: `value` is sent with the native `setValue` method only when it differs from what the field holds (text the user typed is never echoed back), `autofocus` focuses once on creation, and every element's `vnode.dom` has `focus()`, `blur()` and a promise-based `invoke(method, params)` for native UI methods — no `id`, `setTimeout` or `createSelectorQuery()`. See [`INPUT.md`](./INPUT.md).

## Custom fonts

Use a plain CSS `@font-face` rule — not `lynx.addFont()` (that JS API only fires post-mount, too late to win the first-frame race). Three gotchas, all confirmed on real hardware and inherited unchanged from the previous mithril-lynx (none of this is architecture-specific):

- **The font file must be `.ttf`, not `.woff2`** — a `.woff2` `@font-face` compiles fine but the native text renderer silently never applies it.
- **`font-family` set on `:root` (or any ancestor) does not cascade to descendants by default** — `pluginLynxConfig({ enableCSSInheritance: true })` turns that on.
- **A declarative `@font-face` resolves synchronously on the first native `__FlushElementTree()` call**, and that cost scales with how many text nodes resolve it — up to +2s of cold start on a mid/low-end device. Filed upstream as [lynx-family/lynx#9431](https://github.com/lynx-family/lynx/issues/9431). The workaround is a native-side prefetch hook, not a JS-level fix — see [`ANDROID_APK_GUIDE.md`](./ANDROID_APK_GUIDE.md) Part D for the full procedure, or scaffold it directly with `create-mithril-lynx`'s `--with-font <file.ttf>` flag.

## Known gaps

- **`m.trust`** — not present. Stripped from `mithril-runtime` at the source, and Lynx's Element PAPI has no innerHTML-equivalent injection point to reimplement it against anyway (same permanent gap v1 documented).
- **A handful of `m.request` options with no `fetch` equivalent** (`config`, `async: false`, `user`/`password`, `withCredentials`) throw immediately with a message pointing at `FETCH_INVESTIGATION.md`, rather than silently behaving differently — see `REQUEST.md`.
- **The event object passed to handlers is a synthesized snapshot, not a live DOM event.** Lynx has no default actions: `preventDefault()` only sets `e.defaultPrevented` (which `route.Link` honors, as upstream does), and `stopPropagation()` is a no-op — events do not bubble; the fake DOM (`src/fake-dom.js`) dispatches directly to the single node the native event targeted. Code ported from the web that relies on `e.preventDefault()` stopping a browser action (e.g. form submit) has nothing to stop. `e.redraw = false` still works, and is how `route.Link` opts out of the post-tap redraw.

## Testing

```bash
npm test
```

Runs against `@lynx-js/testing-environment`'s real Element PAPI simulation via `rstest` — `test/end-to-end.test.ts` and `test/structural-reload.test.ts` exercise real Mithril diff + real patch replay, not mocks. Device-only claims (focus/text surviving a structural reload on a real `<input>`, the three reload modes triggering correctly over a live dev session) are verified separately on a connected Android device and logged in the rewrite plan's §8 (see "Reference docs"), not re-asserted here. Device checks of the 3.0.0 features are recorded in each feature's own doc (`INPUT.md`, `ROUTE.md`, `UPDATE_ANIMATION_GAP.md`).

## Reference docs

User-facing:

- [`CHANGELOG.md`](./CHANGELOG.md) — what changed in each release, breaking changes first.
- [`ROUTE.md`](./ROUTE.md) — `mithril-lynx/route`: the in-memory `m.route`, asynchronous `set()`, `route.Link`, and the opt-in Android back button with its Kotlin host recipe.
- [`INPUT.md`](./INPUT.md) — `<input>`/`<textarea>` (`value`, `autofocus`) and `vnode.dom.invoke()`/`focus()`/`blur()` for any element's native UI methods.
- [`REQUEST.md`](./REQUEST.md) — `mithril-lynx/request`: `m.request` over Lynx's `fetch`.
- [`ANDROID_APK_GUIDE.md`](./ANDROID_APK_GUIDE.md) — building a native Android host and APK from scratch, Gradle-CLI only, including the `.ttf` cold-start hack from "Custom fonts" above. Automated end to end by `create-mithril-lynx --android`.

Investigations and known gaps:

- [`ROUTE_CONTRACT_ANALYSIS.md`](./ROUTE_CONTRACT_ANALYSIS.md) — `route` checked against Mithril 2.3.8's `m.route`, item by item, plus what Lynx offers for native navigation.
- [`FETCH_INVESTIGATION.md`](./FETCH_INVESTIGATION.md) — the option-by-option gap analysis of `m.request` against Lynx's `fetch`, backed by real-device evidence.
- [`UPDATE_ANIMATION_GAP.md`](./UPDATE_ANIMATION_GAP.md) — the open `<list update-animation>` gap: device evidence, hypotheses and next steps.

Historical plans (removed from the tree in `71a6670`, still in git history):

- `mithril-lynx-v2-desde-cero.md` — the full rewrite plan: architecture decisions, the three reload modes' device verification, and the postmortem on exactly what v1 got wrong.
- `m-route-en-memoria.md` — how `m.route` was first designed and verified for an in-memory, URL-less environment.
- `m-request-fetch-lynx.md` — the `m.request`-vs-`fetch` investigation plan and its execution log.

Read one with `git show 71a6670^:.omo/plans/<file>`.
