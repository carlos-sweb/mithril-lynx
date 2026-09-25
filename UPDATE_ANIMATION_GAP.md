# Known gap: `<list update-animation="default">`

**Status:** open. **Affects:** mithril-lynx 3.0.0 (the native `list` /
`list-item` elements). **Severity:** do not use `update-animation` in
production yet. Everything else about `<list>` is verified on a real device
(see mithril-lynx-ui's `docs/native-papi/papi-07-list-redesign.md`).

## Summary

`update-animation="default"` asks native to animate inserts, removes and
updates. Removing an item that is **on screen** has no correct handling in
mithril-lynx yet:

- if mithril-lynx detaches the removed item's element (which is what it does
  without the animation, and what native needs there), **native crashes when
  the removal animation ends** (SIGSEGV);
- if mithril-lynx leaves it attached (what it does today on such lists, to
  avoid the crash), **stale cells stay drawn over the list** and the removed
  elements accumulate as orphan children of the list.

Inserts and updates were not seen to misbehave; the problem is removals of
items that are currently attached (on screen).

## What mithril-lynx does today

`src/list-runtime.js` tracks the list's `update-animation` attribute
(`setUpdateAnimation()`, fed by `src/apply-patch.js`'s SetAttribute /
RemoveAttribute cases). When it is `"default"`:

- `detachRemoved()` skips detaching removed on-screen items (no crash);
- a `console.warn` is logged once per assignment, pointing here.

Without `update-animation`, removed on-screen items are detached right after
the patch's `update-list-info` flush — the contract verified on the device
(next section). Tests: `test/list.test.ts`, "a removed on-screen item is
detached only after the patch's update-list-info flush" and "with
update-animation on, a removed on-screen item is left attached".

## Evidence (real device)

**Setup:** Samsung SM-A075M, Android 16, Lynx Go 2026.06.06
(`com.funcs.io.lynx.go`), mithril-lynx 3.0.0 (local), `non-contact`'s
country picker migrated to `list`, with sticky letter headers
(`full-span` + `sticky-top` + `reuse-identifier="header"`) and lab
attributes on the list. The bundle came from `rspeedy dev` over
`adb reverse tcp:3000 tcp:3000`, opened with `agent-lynx open`.

**Action:** type `a`, `r`, `g` in the search box (each keystroke filters ~250
rows down, removing many on-screen items), then delete the text again
(re-inserting them).

What native does with a removed on-screen item, per strategy:

| Strategy for a removed on-screen item | Without `update-animation` | With `update-animation="default"` |
|---|---|---|
| Detach it before the patch's flush | **Crash** — SIGSEGV right after `[List] Fail to erase item holder at pos = 73` | not tried (already crashes without) |
| Detach it right after the patch's flush (**current default**) | **Correct** — renders fine, only the visible items stay attached (12–14), no duplicates | **Crash** — SIGSEGV right after `Basic Animation End` |
| Never detach it (**current behavior with the animation**) | Renders fine, but removed elements stay as orphan children of the list and grow with each filter (57, then 125, with duplicated `item-key`s) | **Stale cells** drawn over the real ones (overlapping rows, persisting seconds later); 61 attached elements, duplicated `item-key`s: AD, AF, AL, AM, AO, AR, AZ, DZ, MG, h-M |

Relevant log lines of the animation crash (`adb logcat`, same run):

```
I lynx : [List] DefaultListAdapter::BindItemHolder: enqueue component before render with item_key = AZ ...
W lynx : FiberElement::FlushActionsAsRoot maybe from a wrong parent, this tag:list-item
I lynx : SendCustomEvent event name:layoutcomplete tag:87
I lynx : Basic Animation End.
F libc : Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x3320332e31344c32
```

The backtrace is inside `liblynx.so` with no symbols.

Other facts established on the device, true with or without the animation:

- Native **never calls `enqueueComponent`** for items removed through
  `update-list-info` (instrumented: 9 on-screen items removed, 0 enqueues).
- Native logs `[List] Fail to erase item holder at pos = N` (non-fatal)
  during bulk removals, whether or not mithril-lynx detaches anything.

## How ReactLynx handles removals (for comparison)

Read from `@lynx-js/react` 0.126.1:

- **Snapshot runtime** (`runtime/lib/snapshot/snapshot/snapshot.js`,
  `removeChild` on a list holder): records the removal for
  `update-list-info` and **never calls `__RemoveElement`**.
- **Element-template runtime** (`runtime/lib/element-template/runtime/patch.js`,
  `removeTypedListItem` → `releaseRemovedSubtreeHandles`): drops the item from
  its state and releases JS handles, **without detaching** it natively.

So ReactLynx takes the "never detach" row. Whether a ReactLynx app shows the
same stale cells / orphan growth with `update-animation` on this device has
**not been tested** — that is the first thing to check (below).

## Hypotheses (unverified)

1. Native owns the removed cell until its removal animation finishes, then
   releases it itself; detaching the element earlier frees memory the
   animation still uses (fits the crash right after `Basic Animation End`).
2. The stale cells in the "never detach" row may come from the orphan
   elements still being children of the list element, so they take part in
   the list's layout/render after the animation. ReactLynx may avoid this
   through something mithril-lynx doesn't do (e.g. item-holder bookkeeping
   specific to its runtimes), or may have the same problem.
3. A detach deferred until after the animation (not after the flush) could
   be safe — but mithril-lynx gets no signal for "animation ended"
   (`Basic Animation End` is only a native log line), and a timer on the
   main thread is unverified.

## Next steps to close the gap

1. **Baseline with ReactLynx:** build a minimal ReactLynx page with the same
   filter pattern (`<list update-animation="default">`, keyed items, bulk
   removals) and run it on the same device. Check for stale cells, orphan
   growth (`DOM.getDocument` via `agent-lynx cdp`) and crashes. If ReactLynx
   is also broken, report it upstream and keep this limitation documented.
2. **If ReactLynx works:** diff the exact PAPI call sequence (both runtimes
   log list callbacks behind `__ALOG__`; mithril-lynx can be instrumented the
   same way) to find what native needs that mithril-lynx doesn't send.
3. **Look for a completion signal:** check whether `layoutcomplete` (or any
   other list event) fires after the removal animation, and whether a
   deferred detach from that event is safe.
4. **Acceptance:** the same filter stress on the device with
   `update-animation="default"` — no crash, no stale cells, attached children
   equal to the visible items, no duplicated `item-key`s. Then remove the
   `animatesUpdates` branch and the warning, and turn the second test above
   into a regular removal test.

## Guidance until then

- Don't set `update-animation` on lists that can remove on-screen items
  (filtering, deleting rows, replacing data).
- A list that only appends (a feed with "load more") is not affected by this
  gap, but was not verified with the animation either.
