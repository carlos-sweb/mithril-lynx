# List Tier 2 investigation plan

## Resolution (2026-09-09)

**Fixed and confirmed working on-device.** Step 1 (adding `scroll-orientation`/`list-type`/`span-count`/`item-key` attributes) was necessary but not sufficient — the list still stayed empty after that alone. The real missing piece, found while re-reading `@lynx-js/react`'s own `listUpdateInfo.js` (not `list.js`, which this project had already read) between Steps 1 and 2: native only starts calling `componentAtIndex` at all after receiving a `"update-list-info"` attribute (`{insertAction, removeAction, updateAction}`) alongside a matching `__UpdateListCallbacks` call — `__CreateList` alone never triggers it. A first attempt at this (an `insertAction` array missing `item-key` on each entry) produced a **real, specific native error** — `"Error for illegal list item-key in parse insertAction"` — that directly pinpointed the fix, at which point 37+ cells rendered and scrolled correctly.

This validates the plan's own Step 2/3 reasoning in a different order than expected: rather than needing the element inspector or a known-good control build (Steps 2-3), re-reading the *rest* of the real source (a file adjacent to the one already read, not yet examined) surfaced the answer, and the device itself supplied a specific error once the fix was close enough to be almost right — silence isn't always permanent; sometimes it just means the wrong thing hasn't been tried yet.

See `list.js`'s own code comments and `DEVICE_VERIFICATION.md`'s updated table row for the final, shipped fix. Steps 2-4 below are kept as-written for historical reference / as a template for the *next* silent on-device failure (gestures, currently).

## Problem recap

`mithril-lynx/list`'s `createList(parentNode, options)` calls `__CreateList(pageId, componentAtIndex, enqueueComponent, {})` without crashing, but on a real device (Galaxy A07, 2026-09-09) native never calls `componentAtIndex` — the list area renders as an empty, correctly-sized box and stays empty through scrolling. No error, no console output at all (see `DEVICE_VERIFICATION.md`).

## Evidence gathered

`lynx-examples/examples/list`'s three working demos (`base`, `recyclable`, `async-rendering` — all real, shipped `@lynx-js/react` code, not guesswork) **consistently** set attributes `list.js`'s `componentAtIndex`/`enqueueComponent` machinery itself never touches — meaning these must be set through the *normal* JSX-attribute path (Mithril's `setAttribute`, in our world), not anything specific to the recycling callbacks:

```jsx
<list
  scroll-orientation="vertical"   // present in all 3 examples, always "vertical"
  list-type="single" | "flow"     // present in all 3 examples
  span-count={1} | {2}            // present in all 3 examples
  style={{ width: "100%", height: "100vh", ... }}
>
  <list-item
    item-key={`list-item-${index}`}   // present on EVERY <list-item>, in all 3 examples, no exceptions
    key={`list-item-${index}`}        // Mithril/vdom-level key, already have this equivalent via signMap
    estimated-main-axis-size-px={122} // only in async-rendering (componentAtIndex-driven), likely perf hint not correctness-required
  >
```

`createList()` currently sets **none** of `scroll-orientation`, `list-type`, `span-count` on the list handle, and **never sets `item-key`** on the list-items it creates (only relies on the native-assigned numeric `sign`/`__GetElementUniqueID`, which is a different concept — an opaque native handle id, not the app-level per-item identity key native's layout/recycling logic itself seems to require).

## Hypotheses, ranked by confidence

1. **(High confidence) Missing `list-type`/`scroll-orientation` means native never "activates" the list at all.** These aren't styling — `list-type` in particular ("single" vs "flow") almost certainly selects which native layout algorithm manages the list, and a list with no declared type may simply never start requesting cells. This is the single most likely explanation for "silently does nothing since creation."
2. **(Medium confidence) Missing `item-key` breaks native's own item-identity tracking**, independent of (1) — even if (1) is fixed, native's recycling/diffing may require `item-key` on each cell to know which visible cell corresponds to which logical item, and cells without it could be dropped or never laid out.
3. **(Lower confidence) `span-count` is required, not just an option** — for `list-type="single"`, `span-count={1}` is used in every example even though 1 is presumably already the default for a single-column list; if native's list villager requires this attribute to exist at all (not just defaults sanely), a missing `span-count` could also block activation.
4. **(Low confidence, fallback) There's a missing explicit refresh/reload signal** after `__CreateList()` — e.g. maybe native needs an explicit "tell me how many items you have now" call distinct from the `itemCount` closed over by `componentAtIndex`. Nothing in `@lynx-js/react`'s `list.js` suggests this (it never calls anything beyond `__CreateList`/`__UpdateListCallbacks`/`__FlushElementTree` on create), so this is a fallback hypothesis only if 1-3 don't resolve it.
5. **(Low confidence, fallback) Android-specific requirement not visible in the JS-layer source** — the three examples were read as source, not confirmed to actually run correctly on *this* Android build; if 1-4 all check out and the list still doesn't activate, worth building and running one of these examples for real, on this same device, as a known-good control to compare against via `lynx-devtool`'s element inspector.

## Investigation steps, in order

### Step 1 — Cheap, high-confidence fix attempt: add the missing attributes

Modify `createList()` to accept `scrollOrientation`, `listType`, `spanCount` options (with sane defaults: `"vertical"`, `"single"`, `1`) and `__SetAttribute` them onto the list handle right after `__CreateList(...)`. Modify the item-creation path (`bindFreshItem`/`bindRecycledItem`) to accept an `itemKey(index)` option (default: `String(index)`) and `__SetAttribute(itemWrapper._handle, "item-key", key)` on every created/recycled item, matching what every real example does unconditionally.

This is the fastest thing to try and has the strongest evidence behind it — do this before anything more elaborate.

### Step 2 — Re-run the Demo B list test on-device with `lynx-devtool`'s console AND element inspector both open

If Step 1 doesn't fully fix it, the live element inspector (not used yet this investigation) lets us directly check: does the `<list>` element in the real tree actually show `list-type`/`scroll-orientation`/`item-key` as set? (Rules out "the attribute call silently failed" vs "the attribute was set but native still doesn't react.") Also watch console for anything at all — even a Step-1 partial fix might surface a *new*, more specific error now that native gets further into initializing the list.

### Step 3 — Build and run one of `lynx-examples/examples/list`'s real demos as a known-good control

If Steps 1-2 leave the list still inactive, build `lynx-examples/examples/list`'s `base` demo (the simplest of the three) for real — it needs the full `@lynx-js/react` build pipeline (`pluginReactLynx`, not `mithril-lynx/plugin`), so this means `cd` into that example, `pnpm install` (if not already), `pnpm dev`, and loading it on the same phone via the same `lynx://open?url=...` adb trick already proven this session. Compare its *working* `<list>` element's full attribute set (via `lynx-devtool`'s inspector) against `mithril-lynx`'s non-working one, side by side. This directly answers hypotheses 3-5 without further guessing: whatever attributes/state the working list has that ours doesn't is the actual gap.

### Step 4 — Only if 1-3 don't resolve it: revisit whether `componentAtIndex`'s call signature/return value matches what native expects

Re-check `componentAtIndex`'s return value handling (`ComponentAtIndexCallback`'s type says `number | undefined | Promise<number>` — `createList()` always returns a plain number, which should be fine per the type, but worth double-checking against `list.js`'s actual handling of a *first* call specifically, in case there's a first-call-vs-later-call distinction not obvious from the type signature alone).

## Success criteria

A cell's content (with a `Date.now()`-style suffix, matching the original Demo B) visibly renders inside the list container on-device, and scrolling up/down repeatedly shows correctly recycled (not blank, not duplicated) cells — the same pass criteria already defined in `DEVICE_VERIFICATION.md`'s List Tier 2 row.

## After a fix is found

Update `list.js` itself (new required/defaulted options on `createList()`), add a code comment citing this file the same way every other verified/fixed claim in this package is documented, update `test/list.test.ts` to assert the new attributes are set (op-log style, matching the existing test's `__SetAttribute`/`__SetClasses` assertion patterns), and update `README.md`'s list section + `DEVICE_VERIFICATION.md`'s table row from "confirmed broken" to "confirmed fixed on-device \<date\>".
