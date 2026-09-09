# Real-device verification plan

## Context

Every phase of `mithril-lynx` (1-9) was built and tested against `@lynx-js/testing-environment`'s jsdom-backed PAPI polyfill — fast, deterministic, but a *simulation* of the native Element PAPI, not the real thing. Most of what it simulates is faithful (the polyfill mirrors real PAPI signatures closely, and the shim's core render/diff path already runs in production via `mithril-app`). But several pieces were built from **reading real, shipped `@lynx-js/react` source as ground truth, without ever calling the real native PAPI they call** — the polyfill either doesn't implement that function at all (so a hand-written stub was added) or implements it in a way that can't answer the specific question at stake (a plain-JS mock never crashes the way real native code might).

This plan is the "short device-testing spike" the project plan's own "Parity boundaries" section (points 3 and, implicitly, the Phase 4 op-log work) called for — done once, deliberately, rather than assumed away.

## What's already proven vs. what this plan targets

| Capability | Status | Why |
|---|---|---|
| Main-thread-owned rendering (Phase 1) | **Proven on-device** | `mithril-app`'s original counter ran on the connected Galaxy A07 earlier this session, pre-Phase-3. |
| Data-channel mode (Phase 3) | **Probably fine, worth reconfirming** | Ran on-device once (before the Phase 3→9 refactors), but not since `background.ts` was rewritten and `mithril-lynx` was extracted into its own package. Same PAPI surface as Phase 1, low risk. |
| Renderer mode — `VirtualNodeWrapper` + `applyPatch` (Phase 4) | **Confirmed on-device 2026-09-09** | Demo A run on the Galaxy A07: title/button/counter rendered, tapping alternated the title's background red↔blue via `setStyleProps`→`__SetInlineStyles` and incremented the counter via `setText`, across a real tap→background→redraw→patch round trip, reproducibly (0→1 blue→2 red). **Two real bugs found and fixed in the process** — see below. |
| Refs — `element.js`'s `invoke()` (Phase 5) | **Confirmed WORKING on-device 2026-09-09** | Tapped the test button (`invoke("boundingClientRect", {})`) — resolved with a real native response: `{"code":0,"data":{"top":342.9,"left":105.6,"bottom":382.9,"width":172.8,"height":40,"id":"ref-test-btn","right":278.4,"dataset":{}}}`. Confirms `__InvokeUIMethod`'s callback contract is exactly `(res: {code, data}) => void` as assumed, and the Promise-wrapping in `element.js` works correctly end to end. |
| Refs — `background.js`'s `createRef()` (Phase 5) | **Confirmed WORKING on-device 2026-09-09** | Added a background-thread ref test to Demo B: a main-thread tap dispatches `"bgRefTest"` across the data channel; `background.ts` handles it by calling `createRef("#bg-ref-test-btn").invoke("boundingClientRect", {})` and pushing the result back via `setData()`. Resolved with a real native response, round-tripped through both threads and displayed on the main thread: `{"top":370.67,"left":72.53,"bottom":410.67,"width":238.93,"id":"bg-ref-test-btn","right":311.47,"dataset":{},"height":40}`. Confirms `lynx.createSelectorQuery().select(selector).invoke(...)` works correctly from the background thread, and that the data-channel round trip (background → main, via `updateDataFromBackgroundEventName`) delivers the result intact. |
| Cross-thread function registry (Phase 6) | **Probably fine** | Built entirely on the same `dispatchEvent`/`addEventListener` primitives Phase 3 already proved on-device; no new PAPI surface. |
| Gestures — `createGesture()` (Phase 7) | **Confirmed FIXED and WORKING on-device 2026-09-09** | Three stacked bugs, found and fixed in order (see "Gestures: resolution" below for the full story): (1) callbacks need worklet-ctx wrapping, not plain functions; (2) `enableNewGesture` was never turned on for the app, so native's gesture arena was entirely inactive; (3) native calls gesture callbacks as `(event, controller)`, and the `controller` argument throws under `Function.prototype.apply()`'s argument marshalling specifically — fixed by calling positionally instead. After all three: a real `adb shell input swipe` across the pan-box on the Galaxy A07 drove `panLog` through "pan started" → "pan updating" → "pan ended", with zero console errors. |
| List Tier 1 — `m("list")`/`m("list-item")` (Phase 8) | **Probably fine** | Goes through the exact same `__CreateElement`/keyed-diff path as every other tag; the *tag names* "list"/"list-item" specifically being recognized by native recycling is the only new claim. |
| List Tier 2 — `createList()` (Phase 8) | **Confirmed FIXED and WORKING on-device 2026-09-09** | Root cause found via `LIST_INVESTIGATION.md`'s staged plan: `__CreateList` + attributes alone never triggers `componentAtIndex` — native only starts requesting cells after receiving a `"update-list-info"` attribute (`{insertAction, removeAction, updateAction}`) alongside `__UpdateListCallbacks`, ported from `@lynx-js/react`'s own `listUpdateInfo.js`. A first attempt (missing `item-key` on each `insertAction` entry) surfaced a real, specific native error — `"Error for illegal list item-key in parse insertAction"` — which pinpointed the exact fix. After adding it: 37+ cells rendered and scrolled correctly on the Galaxy A07, each recycled cell showing fresh, correct, non-duplicated content (`Item 19 @<timestamp>` through `Item 36 @<timestamp>`, all distinct). |
| Style-removal quirk (`{backgroundColor: ""}` instead of an absent key, found during Phase 4) | **Confirmed on-device 2026-09-09** | Tapped a red `view` whose style toggled to `{backgroundColor: ""}` — it visibly cleared to transparent immediately, reproducibly. `__SetInlineStyles`/native style engine does treat empty-string as "remove this property," confirming the README's claim. |

One proven baseline, one reconfirmed-in-passing (data-channel mode wasn't re-tested directly this round, still believed fine), seven confirmed working on-device (renderer mode, style-removal, refs `invoke()`, list Tier 2, gestures, background `createRef()`), two remaining "probably fine" items (List Tier 1, cross-thread function registry) that ride entirely on already-proven PAPI surface and were deprioritized rather than skipped by oversight.

**Every item this plan originally set out to verify has now been confirmed on the physical Galaxy A07.** See the per-item resolution notes above and below for what was actually found — three separate real bugs (renderer mode's two, gestures' three, plus the cross-package `mithril` duplication warning) were caught this way that the jsdom suite could not have caught on its own.

### Gestures: resolution (2026-09-09)

Three bugs stacked on top of each other, each one only visible once the previous was fixed — the device's own error messages (or lack of them) guided each step:

1. **Silent, zero-output failure.** Re-read real `@lynx-js/react` source one layer deeper than what `gesture.js` originally consulted (the same technique that resolved List Tier 2). `processGesture.js` (main-thread gesture diffing) alone looked consistent with a plain-function callback; `worklet-runtime/workletRuntime.js` — one level further, in a module that's a **side-effecting import** ReactLynx's own bundle entry pulls in and this project never did — revealed native's real dispatch mechanism: a global `runWorklet(ctx, params)`, whose `validateWorklet(ctx)` requires an object with `_wkltId`, not a plain function. Fixed by adding `src/worklet-runtime.js` (a minimal, from-scratch, `@lynx-js/react`-independent worklet registry) and having `gesture.js` wrap every callback through it.
2. **Still zero output after (1).** Deployed the fix and swiped again — nothing changed at all. Found via `@lynx-js/type-config`'s `config.d.ts`: `enableNewGesture` (`@defaultValue false`) gates native's entire "new gesture arena" — without it, `__SetGestureDetector` registrations are accepted but the runtime silently keeps using "the legacy touch-only gesture path" and never acts on them, regardless of callback shape. Fixed by passing `{ enableNewGesture: true }` to `pluginLynxConfig()` in the consuming app's `lynx.config.ts`.
3. **A real, specific error after (1)+(2)**: `TypeError: not a object`, repeatedly, once per touch-move — the first non-silent signal this whole investigation produced. Bisected step-by-step on-device (temporary diagnostic logging at each sub-expression) to the exact statement: `fn.apply(ctx, args)`, where `args[1]` is a native "gesture controller" host object (`{__SetGestureState, __ConsumeGesture}`) that native passes as a callback's 2nd argument. That object crosses fine through ordinary property reads and positional call arguments, but throws specifically when passed through `Function.prototype.apply()`'s argument-list marshalling. Fixed by calling `fn.bind(ctx)(...args)` instead of `fn.apply(ctx, args)` — matching `@lynx-js/react`'s own `runWorkletImpl`, which also never uses `apply()`/`call()` (`worklet(...params_)`, a plain spread call).

After all three: a real `adb shell input swipe` across the pan-box drove `panLog` through "pan started" → "pan updating" → "pan ended" on the Galaxy A07, zero console errors. See `gesture.js`'s header comment and `src/worklet-runtime.js` for the full citation trail and what's deliberately NOT reimplemented from the real worklet runtime (WorkletRef resolution, `runOnBackground` refcounting, event-method injection).

### Background `createRef()`: resolution (2026-09-09)

The last item this plan had never touched at all. Added a small test to Demo B: an orange button on the main thread (`id="bg-ref-test-btn"`) whose `ontap` calls `dispatchToBackground("bgRefTest")`; `background.ts` handles it with `createRef("#bg-ref-test-btn").invoke("boundingClientRect", {}).then(...)`, pushing the resolved (or rejected) value back to the main thread via `setData()`. No fix was needed — it worked on the first try: `{"top":370.67,"left":72.53,"bottom":410.67,"width":238.93,"id":"bg-ref-test-btn","right":311.47,"dataset":{},"height":40}`, correct and matching the button's own layout. Confirms both halves of the mechanism at once: `lynx.createSelectorQuery()` from the background thread, and the `updateDataFromBackgroundEventName` data-channel round trip carrying the result back to where it's displayed.

### Bugs found by this plan so far

1. **`ReferenceError: __FlushElementTree is not defined`, on background thread.** `src/lynx-mithril-shim.js`'s `flushTree()` unconditionally called the bare global `__FlushElementTree()` at the end of every render/redraw pass — correct for main-thread-owned/data-channel mode, but `renderer/background.js` also calls into this same shim code on the *background* thread, where that PAPI global doesn't exist. Never caught by the jsdom test suite because `@lynx-js/testing-environment`'s `switchToBackgroundThread()` only *overwrites* globals present in its own background-thread snapshot — it never *deletes* a global left over from an earlier `switchToMainThread()` call in the same test process, so `__FlushElementTree` stayed defined by accident across the switch. **Fix**: guard the call with `typeof __FlushElementTree === "function"`.
2. **`TypeError: processData is not a function`.** `renderer/main-thread.js` never installed the `globalThis.processData` default the native engine unconditionally calls on `__RenderPage` — the exact bug Phase 1 already fixed once in the data-channel-mode `main-thread.js`, just never ported to the renderer-mode file. **Fix**: same one-line default as Phase 1.
3. **`console.warn: "Don't reuse attrs object, use new object for every redraw, this will throw in next major"`, on every plain `m(tag, null, ...)` element, every redraw (2026-09-09).** Not a bug in app code — `mithril-app`'s attrs objects are all fresh literals. Root cause: two SEPARATE physical copies of the `mithril` npm package end up in the bundle — one resolved from the app's own `node_modules`, one from `mithril-lynx`'s own `node_modules` (present because `mithril-lynx`'s `file:`-linked local package carries its own `node_modules`, built for its OWN test suite, which shadows Node's normal directory-walk resolution once linked into a consuming app). `src/lynx-mithril-shim.js` deep-imports mithril's internal `render/cachedAttrsIsStaticMap.js` — a `Map` pre-seeded with mithril's `emptyAttrs` singleton, used to recognize its own legitimately-shared empty-attrs object and skip the reuse warning for it. With two copies, the shim's map only knows about ITS OWN copy's `emptyAttrs`, not the app's — so it flags the app's (correctly reused, by design) empty attrs object as user error. **Fix**: `mithril` moved from `dependencies` to `peerDependencies`/`devDependencies` in `mithril-lynx/package.json` (so it doesn't ship as a transitive dependency), plus `plugin.js` now resolves the app's own `mithril` install at build time and adds a webpack/rspack `resolve.alias` forcing every `mithril`/`mithril/*` import — regardless of which file requires it — to that single physical copy. Confirmed on-device: a fresh launch + single tap that previously warned immediately now produces zero warnings, and a full pan gesture (previously 72 occurrences per swipe) produces zero.

4. **`TypeError: processData is not a function`, a third time (2026-09-09).** Found again while building `mithril-app` into a proper hello-world template: the bare main-thread-owned pattern (`lynx.getEngine().addEventListener("__RenderPage", ...)`, README.md's own "Usage — main-thread-owned" minimal example) never installs the `processData` default either — it doesn't go through `mithril-lynx/main-thread.js`, which already carries this fix for data-channel mode. Same root cause as bug 2 above, a third distinct file. **Fix**: same one-line default, added to `mithril-app/src/main-thread.ts` and to README.md's own minimal example so the next app copying it doesn't hit this too.

All four fixes were re-run through the full jsdom suite afterward (42/42 still passing) to confirm no regression.

## Prerequisites (environment)

This session already solved device connectivity once this project; the fix is durable but the *connection* is not (USB is fiddly, and adb currently shows no device attached):

1. **Reconnect the phone.** `adb devices` should show the Galaxy A07 (`R8YYC0VV0PV`) as `device`, not empty or `unauthorized`. If it's not:
   - Confirm the phone is on the USB port that was stable last time (not the original port — that one had genuine hardware-level disconnects, confirmed via `journalctl -k`).
   - USB mode must be "Transferencia de archivos / Android Auto" (MTP), not "Anclaje de red" (tethering) — tethering doesn't expose the ADB interface at all.
   - If `adb devices` shows nothing after replugging: `adb kill-server && adb start-server`, replug.
   - The udev rule (`/etc/udev/rules.d/51-android.rules`, `MODE="0666"`, no `GROUP=` clause — Fedora has no `plugdev` group) is already in place from earlier; it should not need touching again.
2. **`lynx-devtool` is already running** (Electron process confirmed alive, PID from `sep08`). Open it, confirm the device shows up in its device selector once connected. This gives a live element-tree inspector and console log viewer for the device — much better than guessing from on-screen behavior alone, especially for the gesture and list tests where "did the callback fire" isn't otherwise observable.
3. **Dev server**: none currently running. Each verification step below says exactly what to edit before `bun run dev`.

## Demo builds

Two physically separate entry pairs — renderer mode structurally cannot share a bundle with main-thread-owned code (its `main-thread.ts` must be *only* `setupRenderer()`).

### Demo A — renderer mode smoke test (Phase 4)

Verifies the entire op-log → cross-thread patch → real `applyPatch` replay path, including style, text, and event-forwarding ops, with a visually-obvious pass/fail.

`mithril-app/src/main-thread.ts` (temporarily replace its contents):
```ts
import { setupRenderer } from "mithril-lynx/renderer/main-thread";
setupRenderer();
```

`mithril-app/src/background.ts` (temporarily replace its contents):
```ts
import { renderApp, redraw } from "mithril-lynx/renderer/background";
import m from "mithril";

let count = 0;
let color = "red";

const Demo = {
  view: () =>
    m("view", { class: "page" }, [
      m("text", {
        class: "title",
        style: { backgroundColor: color, fontSize: "24px" },
      }, "Renderer mode"),
      m("view", {
        class: "button",
        ontap: () => {
          count += 1;
          color = count % 2 === 0 ? "red" : "blue"; // exercises setStyleProps on every tap
          redraw();
        },
      }, [m("text", { class: "button-label" }, "Tap me")]),
      m("text", { class: "counter" }, String(count)), // exercises setText
    ]),
};

renderApp({ root: () => m(Demo) });
```

**Pass criteria**: page renders (proves `applyPatch`'s `createElement`/`createText`/`appendChild`/`setProp` ops work against real elements), title's background color visibly alternates red/blue on every tap (proves `setStyleProps`'s direct `__SetInlineStyles` call — the exact thing the jsdom test for the style-removal quirk couldn't confirm against real native), counter text increments (proves `setText` **and** the tap→background→redraw→patch round trip, i.e. real event forwarding, not just initial render).

**If it fails**: check `lynx-devtool`'s console for a thrown error first — most likely failure mode is a PAPI call rejecting an argument shape (e.g., if real `__CreatePage`/`__CreateElement` need something the virtual replay doesn't provide). If the page renders but taps do nothing, event forwarding (`addEvent`/`removeEvent` ops, or the `rendererEventEventName` round trip) is the suspect — check whether the real `LynxNodeWrapper.addEventListener`'s wrapped listener is actually firing (`lynx-devtool`'s element inspector may show registered listeners).

### Demo B — gestures, list Tier 2, refs, style-removal (Phases 5, 7, 8)

These are all main-thread-owned (no background thread needed), so they can share one bundle. Restore `main-thread.ts`/`background.ts` to their current data-channel-mode contents when done with Demo A, then temporarily swap `src/index.js`'s `Counter` component for:

```js
"use strict"
const { wrapElement } = require("mithril-lynx/element")
const { createGesture, GestureType } = require("mithril-lynx/gesture")
const { createList } = require("mithril-lynx/list")
const m = require("mithril")

const items = Array.from({ length: 40 }, (_, i) => `Item ${i}`)
let panLog = "no pan yet"
let styleRemoved = false

const Demo = {
  view: function () {
    return m("view", { class: "page" }, [
      // --- Gesture test: a pan gesture over a big tappable box ---
      m("text", null, "Pan over the box below:"),
      m("view", {
        id: "pan-box",
        style: { backgroundColor: "green", height: "100px" },
        oncreate: function (vnode) {
          createGesture(vnode.dom, {
            type: GestureType.PAN,
            callbacks: {
              onStart: function () { panLog = "pan started"; m.redraw() },
              onUpdate: function () { panLog = "pan updating"; m.redraw() },
              onEnd: function () { panLog = "pan ended"; m.redraw() },
            },
          })
        },
      }),
      m("text", { id: "pan-log" }, panLog),

      // --- Style-removal test: tap to clear backgroundColor entirely ---
      m("view", {
        id: "style-box",
        style: styleRemoved ? { height: "40px" } : { backgroundColor: "red", height: "40px" },
        ontap: function () { styleRemoved = !styleRemoved; m.redraw() },
      }),
      m("text", null, "Tap the box above: background should visibly clear, not just stay red"),

      // --- Ref test: invoke a real native method (scrollTop on a scroll-view, if available; falls back to a no-op-safe method) ---
      m("view", {
        id: "ref-test-btn",
        ontap: function (e) {
          wrapElement(e.currentTarget).invoke("boundingClientRect", {}).then(function (res) {
            panLog = "invoke() resolved: " + JSON.stringify(res)
            m.redraw()
          }).catch(function (err) {
            panLog = "invoke() rejected/threw: " + String(err)
            m.redraw()
          })
        },
      }, [m("text", null, "Tap to test element.invoke()")]),

      // --- List Tier 2 test ---
      m("text", null, "Scroll the list below; watch for blank/duplicated cells"),
      m("view", {
        id: "list-container",
        style: { height: "300px" },
        oncreate: function (vnode) {
          var list = createList(vnode.dom, {
            itemCount: items.length,
            renderItem: function (index) {
              return m("text", { class: "cell" }, items[index] + " (rendered at " + Date.now() + ")")
            },
          })
          vnode.dom.appendChild(list)
        },
      }),
    ])
  },
}

module.exports = { root: m(Demo) }
```

(This bypasses `main-thread.js`'s `setupApp`/data-channel wiring for the test — simplest is to also temporarily swap `main-thread.ts` back to the **original Phase-1 form**, calling `shim.renderToPage` directly on `__RenderPage`, since this demo has no background-thread state at all. Restore both `main-thread.ts` and `src/index.js` to their real contents afterward — this is throwaway verification code, not meant to be committed.)

**Pass/fail per capability:**

(The gestures item below is the ORIGINAL pre-execution plan, kept for historical reference — see "Gestures: resolution (2026-09-09)" above for what was actually found and fixed. Re-run this exact swipe test against the fixed `gesture.js` next.)

- **Gestures**: drag a finger across the green box. If `pan-log`'s text updates through "pan started" → "pan updating" → "pan ended", plain-function callbacks work — no change needed anywhere. If nothing updates, or `lynx-devtool`'s console shows an error at the `createGesture`/`__SetGestureDetector` call, native likely rejected or ignored a plain function; see "If gestures fail" below.
- **Style removal**: tap the red box. It should turn back to whatever the default background is (transparent/page background) — not stay red, and not show any visual glitch. If it stays red, `{backgroundColor: ""}` is not being treated as "clear" by native, and `setStyleProps`'s comment/README claim needs correcting (the fix would likely be: `applyPatch`'s `setStyleProps` case must filter out empty-string values before calling `__SetInlineStyles`, or call `__RemoveAttribute`-equivalent for them).
- **Refs `invoke()`**: tap the button. `lynx-devtool` or the on-screen text should show *some* resolution (either real data or a real rejection) — the important signal is that it **doesn't hang forever or crash the app**. A crash means `__InvokeUIMethod`'s real callback contract differs from the assumed `(res: {code, data}) => void` shape.
- **List Tier 2**: scroll up and down repeatedly, fast and slow. Watch for: blank cells (recycling returned a bad sign), duplicated content (sign collision), or a native crash/red-screen (wrong `__FlushElementTree` options shape). If cells consistently show correct, freshly-rendered content (the `Date.now()` suffix should change each time a cell scrolls back into view after being recycled), Tier 2 is confirmed end-to-end.

**If gestures fail** (plain function rejected): the fallback is to make `callbacks` values in `gesture.js` accept anything already Worklet-shaped from `@lynx-js/react`'s own worklet runtime (i.e., document that `mithril-lynx/gesture` requires the app to bring its own minimal worklet wrapper), or — more in keeping with this project's zero-compiler stance — investigate whether native accepts a **serializable descriptor plus a side-channel registry lookup** (similar in spirit to Phase 6's cross-thread call registry, adapted to however native actually invokes the callback). Don't guess further than that without seeing the actual native error first.

## Order of execution

1. Reconnect device (prerequisite).
2. **Demo A (renderer mode)** first — it's the largest, most foundational piece (Phase 4 was explicitly the "Large/High-risk" phase), and if it's broken, that's the highest-value thing to know before investing more trust in anything built on similar patterns.
3. **Demo B, gestures sub-test** next — highest documented uncertainty (README already flags it explicitly), and the one most likely to need a design change rather than a small fix.
4. **Demo B, list Tier 2 sub-test** — second-highest uncertainty, same category of risk (an options-object shape copied from source, never executed).
5. **Demo B, refs `invoke()` sub-test** and **style-removal sub-test** — lower risk, quick to confirm, fine to batch together at the end.
6. Reconfirm data-channel mode (Phase 3) still works on-device now that `background.ts` has been rewritten several times since the last real-device run — cheapest possible check: revert Demo A/B changes and just tap the existing counter demo once.

## Recording results

Update the "What's already proven vs. what this plan targets" table above in place once each row is confirmed (change "Never run on a real device" → "Confirmed on-device <date>", or record what broke and what the fix was). If a fix is needed, it belongs in the relevant `.js` file with a comment citing this file, the same way every other verified/unverified claim in this package is already documented — not as a silent behavior change.
