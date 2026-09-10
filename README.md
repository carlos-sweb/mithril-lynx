# mithril-lynx

Mithril.js rendered through [Lynx](https://lynxjs.org)'s Element PAPI — the core runtime layer of a Mithril-based alternative to [`@lynx-js/react`](https://lynxjs.org/react/).

## What this package is

`src/lynx-mithril-shim.js` is a contract-complete, line-by-line port of `mithril/render/render.js@2.3.8`: the exact same diff algorithm (`createNode`/`updateNodes`/`updateNode`/keyed-diff-with-LIS/etc.) as upstream Mithril, with every DOM call it makes redirected onto Lynx's Element PAPI (`__CreateView`, `__AppendElement`, `__SetAttribute`, `__SetInlineStyles`, `__AddEventListener`, ...) instead of the browser DOM. See `CONTRACT.md` for the exhaustive, reverse-engineered spec of exactly which DOM surface Mithril's renderer touches — that document is the reference this shim is built and validated against.

`mithril` is a `peerDependency`, not a `dependency` — install it yourself (`mithril@2.3.8`) rather than relying on a copy `mithril-lynx` pulls in. The shim deep-imports mithril's own internal `emptyAttrs`/`cachedAttrsIsStaticMap` singletons (needed to correctly recognize mithril's own legitimately-reused empty attrs object); a second physical copy of `mithril` anywhere in the dependency graph breaks that recognition and produces a spurious `"Don't reuse attrs object"` console warning on every plain `m(tag, null, ...)` element, every redraw (confirmed and fixed on-device 2026-09-09 — see `DEVICE_VERIFICATION.md`). `mithril-lynx/plugin`'s `pluginMithrilLynx()` already forces a single resolution via a build-time alias, so apps using it don't need to do anything extra beyond installing `mithril` themselves.

Everything in this README is tested against `@lynx-js/testing-environment`'s jsdom-backed PAPI simulation, not a real device — several capabilities (renderer mode, gestures, list Tier 2, refs) were built from reading real `@lynx-js/react` source as ground truth without ever calling the real native PAPI they call. See `DEVICE_VERIFICATION.md` for exactly which claims are still unconfirmed on real hardware and the plan to confirm them.

This is part of a larger effort to bring Mithril to full functional parity with ReactLynx's dual-thread architecture, refs, gestures, list virtualization, and testing tooling — see the project plan for the full roadmap. Three rendering modes exist today:

- **Main-thread-owned** (`mithril-lynx` + `mithril-lynx/main-thread` alone, no `background.ts`): the app renders directly on the main thread, synchronously, on first paint. Simplest option; no dual-bundle build needed.
- **Data-channel mode** (`mithril-lynx/main-thread` + `mithril-lynx/background`, opt in by adding a sibling `background.ts` — see `mithril-lynx/plugin`): business-logic state lives on the background thread; only plain JSON data crosses the thread boundary, and the main thread's Mithril render turns it into UI. First paint waits one round trip for the background thread's initial push, in exchange for keeping business logic off the main thread.
- **Renderer mode** (`mithril-lynx/renderer/main-thread` + `mithril-lynx/renderer/background`): Mithril's diff algorithm itself runs on the background thread, against a virtual (op-log-recording) tree; the main thread replays the ops against real elements and forwards real events back by node id. This is the closest analog to ReactLynx's default architecture — full reconciliation off the main thread, not just data pushes — at the cost of first paint waiting for the background thread's initial patch (same tradeoff as data-channel mode, one level deeper).

## Usage — main-thread-owned

```js
import shim from "mithril-lynx";
import m from "mithril";

// The native engine unconditionally calls a global processData(initData)
// on every __RenderPage/__UpdatePage — install a pass-through default
// (mithril-lynx/main-thread does this for you in data-channel mode, but
// this bare pattern doesn't go through that module).
Object.assign(globalThis, { processData: (data) => data });

const engine = lynx.getEngine();
engine.addEventListener("__RenderPage", () => {
  const page = __CreatePage("0", 0);
  shim.renderToPage(page, m(MyComponent));
});
```

Subsequent UI updates flow through `shim.redraw()` (called automatically by event handlers bound via Mithril's own `on*` attrs, since the shim ports Mithril's `EventDict`/redraw machinery verbatim) — **never plain `m.redraw()`**, which is a no-op in this shim-based architecture.

## Usage — data-channel mode

`main-thread.ts`:

```js
import { setupApp, getData, dispatchToBackground } from "mithril-lynx/main-thread";
import m from "mithril";

const Counter = {
  view: () => m("text", { ontap: () => dispatchToBackground("increment") }, String(getData()?.count ?? 0)),
};

setupApp({ root: () => m(Counter) });
```

`background.ts` (sibling file — `mithril-lynx/plugin` picks it up automatically as a second bundle):

```js
import { setupBackground, getData, setData, setBackgroundEventHandler } from "mithril-lynx/background";

setupBackground();
setData({ count: 0 }, { shouldSyncToMainThread: false });
setBackgroundEventHandler((handlerName) => {
  if (handlerName === "increment") setData({ count: (getData().count ?? 0) + 1 });
});
```

`root()` is called exactly once, on the first `__RenderPage`; every later update — from the engine's `__UpdatePage` or a `background.setData()` push — flows through the shim's own `redraw()`, re-invoking the component's `view()` (not `root()` again). See `mithril-lynx/test/data-channel.test.ts` for a complete worked example and the full cross-thread test. `mithril-app` (this project's own hello-world template) uses main-thread-owned mode instead — see its `src/{main-thread,index}.js` for that simpler pattern applied end to end.

## Usage — renderer mode

`main-thread.ts`:

```js
import { setupRenderer } from "mithril-lynx/renderer/main-thread";

setupRenderer();
```

`background.ts`:

```js
import { renderApp, redraw } from "mithril-lynx/renderer/background";
import m from "mithril";

let count = 0;
const Counter = {
  view: () => m("text", { ontap: () => { count += 1; redraw(); } }, String(count)),
};

renderApp({ root: () => m(Counter) });
```

Unlike data-channel mode, `main-thread.ts` needs no app-specific code at all — `setupRenderer()` is generic; all app logic, including the Mithril component tree, lives in `background.ts`. Call `redraw()` (not `shim.redraw()`) after mutating state in a handler — it re-invokes the view and flushes the resulting patch to the main thread. See `mithril-lynx/test/renderer-ops.test.ts` (op-log assertions) and `mithril-lynx/test/renderer-integration.test.ts` (full round trip through real PAPI replay, including a tap forwarded from the main thread back to the background thread's handler) for worked examples.

## Refs / native imperative bridge

Mithril has no `useRef`/`ref` hook system — the idiomatic way to reach a real node is Mithril's own `oncreate(vnode)`/`onupdate(vnode)` lifecycle attrs, which hand you `vnode.dom` directly. Two helpers cover the two threads:

- **Main-thread side** (`mithril-lynx/element`): `wrapElement(node)` wraps any node with a `_handle` (a real `LynxNodeWrapper`, or a raw result from `querySelector`) in ergonomic methods `render.js` itself never needs — `setStyleProperty(ies)`, `setAttribute` (mirrors the real wrapper's class/id/data-prefixed/generic special-casing), `querySelector(All)`, `animate`/`playAnimation`/`pauseAnimation`/`cancelAnimation`, and `invoke(method, params)` (wraps `__InvokeUIMethod`'s callback in a Promise).

  ```js
  import { wrapElement } from "mithril-lynx/element";

  m("input", {
    oncreate: (vnode) => wrapElement(vnode.dom).invoke("focus"),
  });
  ```

  **Confirmed working on a real device** (see `DEVICE_VERIFICATION.md`): `invoke("boundingClientRect", {})` resolved with a real native response (`{code: 0, data: {top, left, width, height, ...}}`), confirming `__InvokeUIMethod`'s callback contract matches what this file assumes.

- **Background-thread side** (`mithril-lynx/background`'s `createRef(selector)`): the background thread has no direct native handle, so imperative calls go through Lynx's existing `lynx.createSelectorQuery().select(selector).invoke({...}).exec()` bridge — the same primitive ReactLynx's own background-thread refs ultimately use.

  ```js
  import { createRef } from "mithril-lynx/background";

  const input = createRef("#my-input");
  await input.invoke("focus"); // resolves with success data, rejects with failure data
  ```

  **Confirmed working on a real device 2026-09-09** (see `DEVICE_VERIFICATION.md`): a background-thread `createRef(selector).invoke("boundingClientRect", {})` resolved with a real native response, round-tripped back to the main thread through the normal data channel and displayed there.

**Known quirk, not a bug**: style patches sometimes carry a key with an empty-string value (e.g. `{ backgroundColor: "" }`) instead of omitting it entirely, when a non-dash-case style property is cleared after being set via plain assignment rather than `style.setProperty()`. This matches the real `LynxStyleProxy`'s exact behavior in main-thread-owned mode too (verified — not something renderer mode changed), and `__SetInlineStyles`/CSSOM treat an empty string as "clear this property," so it's functionally equivalent to an absent key.

## Cross-thread function calls (worklet substitute)

ReactLynx's Main Thread Scripting (worklets) exists to solve two different problems, and only one of them needs a compiler:

- **A gesture/tap handler needs to run on the thread it's defined on** — under mithril-lynx's two-file convention, this needs *zero new mechanism*: a `main-thread:bindtap`-equivalent handler is just an ordinary function in `main-thread.ts`/`background.ts`, never mixed with the other thread's code to begin with.
- **One thread needs to trigger a named action on the other thread outside the normal render/data cycle** — this genuinely can't cross a JS-engine boundary without either a compiler (to extract and ship a closure) or an explicit registry. `registerHandler`/`runOnMainThread`/`runOnBackground` (in `mithril-lynx/main-thread` and `mithril-lynx/background`) are that registry — call/return correlated, Promise-based:

  ```js
  // main-thread.ts
  import { registerHandler } from "mithril-lynx/main-thread";
  registerHandler("flashBackground", (color) => { /* ... */ });
  ```
  ```js
  // background.ts
  import { runOnMainThread } from "mithril-lynx/background";
  await runOnMainThread("flashBackground", "red");
  ```

  This is equal *capability* to upstream's own `runOnMainThread`/`runOnBackground` (both are async serialized RPC under the hood there too, not real closure transfer) — only worse *ergonomics*, since there's no compiler to auto-extract an inline closure at the call site. Args and return values must be JSON-serializable, and handlers must be named and registered ahead of time, on the thread they run on.

  **Explicitly rejected**: reconstructing a closure via `fn.toString()` + `new Function(...)` shipped across the wire, as a sugar layer over the registry. It breaks under any minifier/bundler that renames free identifiers, can't support real closures anyway (so it wouldn't actually improve on "write a named function"), and fails only in production builds, never in dev. Not revisited without re-litigating this tradeoff.

## Gestures

`mithril-lynx/gesture`'s `createGesture(node, options)` is a thin, same-thread wrapper over `__SetGestureDetector` — no cross-thread serialization, since gesture recognition and its callbacks all run on the main thread already. It DOES need a small amount of worklet machinery, though (see below) — native invokes gesture callbacks by looking them up in a registry, not by calling a function value directly, and `mithril-lynx` supplies a minimal, from-scratch registry for exactly this (`src/worklet-runtime.js`), not a dependency on `@lynx-js/react`'s own.

```js
import { createGesture, GestureType } from "mithril-lynx/gesture";

m("view", {
  oncreate: (vnode) => {
    createGesture(vnode.dom, {
      type: GestureType.PAN, // or the string "pan"
      callbacks: {
        onStart: () => { /* ... */ },
        onUpdate: () => { /* ... */ },
      },
    });
  },
});
```

Each callback is actually invoked as `(event, controller) => {}` — `controller` is a native gesture-arena handle (`{__SetGestureState, __ConsumeGesture}`); most callbacks can ignore it and just take `event` (or no parameters at all, as above).

`waitFor`/`simultaneousWith`/`continueWith` take arrays of *other* `createGesture()` return values, for gesture-arena composition (e.g. a pan that only starts after a tap gesture fails). If a callback needs to notify background-owned state, call `main-thread.js`'s `runOnBackground()` (previous section) from inside it — an explicit, opt-in cross-thread hop, not something gesture composition requires structurally.

**Confirmed WORKING end-to-end on a real device 2026-09-09** (see `DEVICE_VERIFICATION.md` for the full story): a real `adb shell input swipe` across a `PAN`-gesture element drove its callbacks through start → update → end with zero errors. Getting there took three stacked fixes, in order: (1) gesture callbacks must be wrapped as worklet-ctx objects (`{_wkltId}`), not passed as plain functions — `createGesture()` does this internally via `src/worklet-runtime.js`, a small from-scratch worklet registry, transparent to callers; (2) the consuming app's `lynx.config.ts` must pass `{ enableNewGesture: true }` to `pluginLynxConfig()` — without it, native's entire gesture arena stays off and `__SetGestureDetector` calls are silently inert; (3) `worklet-runtime.js` must call callbacks positionally (`fn.bind(ctx)(...args)`), never via `Function.prototype.apply()` — the native `controller` argument throws under `apply()`'s argument marshalling specifically. (1) and (3) are internal to this package; (2) is a one-line addition an app using `mithril-lynx/gesture` must make itself.

## Lists

Two tiers, matching the real complexity spread in Lynx's own `list` examples:

- **Tier 1 (prefer this)**: `<list>`/`<list-item>` need no code at all — they're just ordinary tags through the existing shim:

  ```js
  m("list", { class: "my-list" },
    items.map((item) => m("list-item", { key: item.id }, [ItemView(item)])))
  ```

  Native does cell recycling at the native layer; Mithril's own already-tested keyed/LIS diff (`test/keyed-diff.test.ts`) computes add/remove/reorder of the `list-item` children — no different from any other keyed list.

- **Tier 2 — `mithril-lynx/list`'s `createList(parentNode, options)`** (opt in, for when you specifically need native-driven recycling, e.g. very large lists): an imperative escape hatch like `element.js`/`gesture.js` — call from `oncreate(vnode)`, attach the result yourself:

  ```js
  import { createList } from "mithril-lynx/list";

  m("view", {
    oncreate: (vnode) => {
      const list = createList(vnode.dom, {
        itemCount: items.length,
        renderItem: (index) => m("text", { class: "cell" }, items[index].label),
      });
      vnode.dom.appendChild(list);
    },
  });
  ```

  The sign/recycle-pool design (cells reused by *type*, matching RecyclerView/UICollectionView semantics) and the exact `__FlushElementTree({ triggerLayout, operationID, elementID, listID })` call shape are ported from `@lynx-js/react`'s own shipped `list.js` — real, proven code. `renderItem(index)` must return a fresh vnode every time it's called (it can be called more than once for the same index, on recycling); a recycled cell's content is *diffed* into its existing DOM subtree via Mithril's own diff, not recreated — verified in `test/list.test.ts` by asserting no new `__CreateElement` calls happen on reuse.

  `createList()` also sets `scroll-orientation`/`list-type`/`span-count` on the list and `item-key` on every item (all required by native, confirmed by a real device never calling `componentAtIndex` without them — see `LIST_INVESTIGATION.md`), and sends a `"update-list-info"` attribute (`{insertAction, removeAction, updateAction}`, each entry needing `position`, `type`, and `item-key`) alongside `__UpdateListCallbacks` on creation and on every `setItemCount()` call — **this is the piece that actually makes native start calling `componentAtIndex` at all**; without it, `__CreateList` silently does nothing forever.

  **Confirmed WORKING on a real device 2026-09-09** (see `DEVICE_VERIFICATION.md`): 37+ cells rendered and scrolled correctly, each recycled cell showing fresh, correct, non-duplicated content.

  **Deliberately out of scope for v1** (documented, not silently missing): deferred list items (ReactLynx's `defer`/`isReady` promise dance), `componentAtIndexes` batching, and independent per-item redraw after the initial bind — a bound cell's content is recomputed fresh from `renderItem(index)` only when native calls `componentAtIndex` for it (scroll-driven reuse), not automatically when app state changes.

## Navigation

`mithril-lynx/navigation`'s `createNavigator({ initial, initialAttrs? })` is a stack-based, in-memory screen navigator — deliberately **not** built on `m.route` (see "Known permanent gaps" below: Lynx pages have no URL/History API for `m.route` to hook into). Android's own Activity navigation doesn't need URLs either — it's a plain back-stack — so this is that idea directly, not a URL-shaped abstraction forced onto an environment with no URLs.

```js
import { createNavigator } from "mithril-lynx/navigation";
import m from "mithril";

const Home = {
  view: (vnode) => m("view", { ontap: () => vnode.attrs.nav.push(Details, { id: 42 }) }, [
    m("text", null, "Go to details"),
  ]),
};
const Details = {
  view: (vnode) => m("view", { ontap: () => vnode.attrs.nav.pop() }, [
    m("text", null, "Details for #" + vnode.attrs.id + " — tap to go back"),
  ]),
};

const nav = createNavigator({ initial: Home });
shim.renderToPage(page, m(nav.Navigator)); // main-thread-owned mode
```

Every screen the navigator renders receives its own `attrs` plus a `nav` prop (`push`/`pop`/`replace`/`canGoBack`/`depth`), so screens don't need to import the navigator instance separately to navigate onward. Only the top of the stack is ever mounted — previous screens are torn down, not kept alive offscreen (matching how most single-activity/single-page navigators behave); a popped screen that needs to remember its own state should keep that state somewhere the app already owns (a module-level store, `background.js`'s data store, etc.), not rely on its own component instance surviving the pop.

Built on `shim.redraw()` alone, so it works unmodified in all three rendering modes (main-thread-owned, data-channel, renderer) — `nav.push()`/`pop()`/`replace()` just trigger whichever redraw mechanism that mode already uses.

**Deliberately out of scope for v1**: screen transition animations (left entirely to the app's own CSS/styling on whatever wraps `nav.Navigator`), and hardware back-button integration (no documented Lynx PAPI hook for it was found — wire a screen's own back-affordance to `nav.pop()` instead, as in the example above).

## Known permanent gaps

- `m.trust` / innerHTML vnodes — no Lynx PAPI equivalent to raw innerHTML injection.
- `m.route` — Lynx pages aren't URL-addressable the way DOM `history` is.

## Known gap, not permanent

- `m.request` — throws (`XMLHttpRequest is not defined`) rather than silently misbehaving: it's hard-wired to a real `XMLHttpRequest`, which doesn't exist in Lynx's JS runtime (neither the main-thread Lepus/QuickJS engine nor the background JS thread). Unlike `m.trust`/`m.route` above, this isn't structural — Lynx does have its own networking primitives — it just hasn't been wrapped in a `$window`-shaped compat layer yet. Use Lynx's own networking API directly (wrapped in a `Promise`, if desired) until this exists.

## Rest of the public `m` API — what's actually used

Beyond hyperscript (`m(...)`) itself, only `m.fragment` and `m.censor` are used as shipped from the real `mithril` package — both are pure data/diff logic with no DOM dependency, so they work unmodified. `m.render`, `m.mount`, and `m.redraw` are never called from the real package at all: `mithril-lynx` has its own equivalents (`shim.renderToPage()`/`shim.render()`/`shim.redraw()`, this README's own "Usage" sections) that target the Lynx Element PAPI instead of the DOM — calling the *real* `m.mount()`/`m.redraw()` does nothing here, since they're wired to `m.render()`'s own DOM-only render path, which this project's apps never invoke.

## Compat with the plain-JS ecosystem

Mithril was never hooks-based, so — unlike React — there's no special rules-of-hooks compatibility story to build: `m.redraw()` after any state mutation already works with any plain-JS state library (a simple pub/sub store, streams, whatever). Nothing in this package needs to shim a specific state-management library for that reason; if something in the ecosystem doesn't work, it's not because of a hooks-equivalence gap.

## Testing

```bash
bun install
bun run test
```

Tests run against `@lynx-js/testing-environment`'s jsdom-backed PAPI polyfill. The polyfill itself is published as `mithril-lynx/testing`'s `installTestingPolyfills()` (see `test/setup.ts` for the one-line setup) — consuming apps can use the exact same polyfill for their own tests instead of maintaining a duplicate copy; see `mithril-app/test/setup.ts` for a worked example.

**Not provided**: Fast Refresh and a devtools/inspector bundle (project plan, Phase 9 / subsystem 12) are explicitly out of scope — they're deep, compiler-driven DX features in upstream ReactLynx with no zero-compiler equivalent worth building. `rspeedy dev`'s existing full-reload-on-file-change loop is the honest substitute.
