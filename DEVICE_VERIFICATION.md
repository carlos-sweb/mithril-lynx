# Real-device verification plan

## Context

Every phase of `mithril-lynx` (1-9) was built and tested against `@lynx-js/testing-environment`'s jsdom-backed PAPI polyfill — fast, deterministic, but a *simulation* of the native Element PAPI, not the real thing. Most of what it simulates is faithful (the polyfill mirrors real PAPI signatures closely, and the shim's core render/diff path already runs in production via `mithril-app`). But several pieces were built from **reading real, shipped `@lynx-js/react` source as ground truth, without ever calling the real native PAPI they call** — the polyfill either doesn't implement that function at all (so a hand-written stub was added) or implements it in a way that can't answer the specific question at stake (a plain-JS mock never crashes the way real native code might).

This plan is the "short device-testing spike" the project plan's own "Parity boundaries" section (points 3 and, implicitly, the Phase 4 op-log work) called for — done once, deliberately, rather than assumed away.

## What's already proven vs. what this plan targets

| Capability | Status | Why |
|---|---|---|
| Main-thread-owned rendering (Phase 1) | **Proven on-device** | `mithril-app`'s original counter ran on the connected Galaxy A07 earlier this session, pre-Phase-3. |
| Data-channel mode (Phase 3) | **Probably fine, worth reconfirming** | Ran on-device once (before the Phase 3→9 refactors), but not since `background.ts` was rewritten and `mithril-lynx` was extracted into its own package. Same PAPI surface as Phase 1, low risk. |
| Renderer mode — `VirtualNodeWrapper` + `applyPatch` (Phase 4) | **Never run on a real device** | Passed 16 jsdom-simulated tests, but the entire point of the op-log/replay design is that it drives *real* `LynxNodeWrapper` methods on the main thread — this has literally never happened outside the test polyfill. |
| Refs — `element.js`'s `invoke()` (Phase 5) | **Never run on a real device** | The jsdom polyfill's `__InvokeUIMethod` is a stub this project wrote itself (`callback({code:0, data:{method,params}})` — always "succeeds," proves nothing about real native method dispatch. |
| Refs — `background.js`'s `createRef()` (Phase 5) | **Never run on a real device** | The testing environment's own `NodesRef.invoke()` throws "not implemented" — tests stub `lynx.createSelectorQuery` entirely, so nothing here has touched real `selectorQuery` behavior. |
| Cross-thread function registry (Phase 6) | **Probably fine** | Built entirely on the same `dispatchEvent`/`addEventListener` primitives Phase 3 already proved on-device; no new PAPI surface. |
| Gestures — `createGesture()` (Phase 7) | **Never run on a real device — highest uncertainty** | `README.md` already flags this: the `config`/`relationMap` shape is copied from real ReactLynx source, but whether `__SetGestureDetector`'s callback slot accepts a **plain function** (this package's assumption) or specifically expects a **Worklet-shaped object** has never been tested. If wrong, gestures silently do nothing, or native rejects the call outright. |
| List Tier 1 — `m("list")`/`m("list-item")` (Phase 8) | **Probably fine** | Goes through the exact same `__CreateElement`/keyed-diff path as every other tag; the *tag names* "list"/"list-item" specifically being recognized by native recycling is the only new claim. |
| List Tier 2 — `createList()` (Phase 8) | **Never run on a real device** | `__FlushElementTree(root, {triggerLayout, operationID, elementID, listID})`'s options object is copied from real ReactLynx source; the jsdom polyfill's `__FlushElementTree()` ignores all arguments, so a wrong shape would never surface as a test failure — only on a real device, where native actually reads those fields to know which list cell to lay out. |
| Style-removal quirk (`{backgroundColor: ""}` instead of an absent key, found during Phase 4) | **Assumed, not confirmed** | The README states `__SetInlineStyles`/CSSOM treat `""` as "clear this property" — true for browser CSSOM, asserted but not confirmed for Lynx's native style engine specifically. |

Six real unknowns, one already-proven baseline, two "probably fine, cheap to reconfirm." The plan below is ordered by risk × blast radius, not by phase number.

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
