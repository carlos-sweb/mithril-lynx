# `<input>`, `<textarea>` and native UI methods

Since mithril-lynx 3.0.0.

On the web, a Mithril field is just attributes:

```js
m("input", { value: name, autofocus: true, oninput: (e) => (name = e.target.value) })
```

Lynx's native `<input>` and `<textarea>` have no `value` or `autofocus` attribute. The text is set and focus is given only through **UI methods** (`setValue`, `focus`, `blur`, `getValue`, `setSelectionRange`), which native exposes through `lynx.createSelectorQuery().select("#id").invoke(...)`. Until now that meant:

- giving the field an `id`;
- calling the selector query by hand;
- wrapping the call in a `setTimeout`, because in `oncreate` the element doesn't exist natively yet.

mithril-lynx now does this for you, so the web form works as is:

```js
m("input", {
  value: name,                                // sent with setValue when it changes
  autofocus: true,                            // focuses once, on creation
  placeholder: "Name",
  oninput: (e) => (name = e.detail.value),    // Lynx puts the payload under `detail`
})
```

## `value`

- `value` works like the web's controlled input. When the value you render differs from what the field holds, mithril-lynx sends one `setValue`.
- The field's `vnode.dom.value` is synced from every event it fires (`input`, `focus`, `blur`, `confirm`) before your handler runs.
- Echo suppression is built in:
  - Mithril only writes `value` when it differs from `dom.value`, so text the user just typed is never sent back to native, and the cursor doesn't jump.
  - A value your app *changes* (clearing the field, forcing uppercase, trimming) is sent once.
- Setting `value` to `null`/`undefined`, or dropping the attribute, clears the field (as on the web).
- To leave the field **uncontrolled**, don't pass `value`. Read the text from `e.detail.value` in `oninput`, from `vnode.dom.value`, or with `vnode.dom.invoke("getValue")`.
- For an initial text only, pass `value` on the first render and stop passing it afterwards.

### Keystrokes racing a programmatic value

Your handler runs on the background thread, while the user keeps typing on the main thread. Take a transform like `toUpperCase()`: by the time `"AB"` reaches native, the user may have typed `"abc"`, and sending `"AB"` would erase the `c`.

To prevent that:
- the main thread counts each field's native `input` events and forwards the count with every event;
- a `setValue` carries the count it was computed from;
- a `setValue` computed before the latest keystroke is dropped, and that keystroke's own event re-renders and sends the up-to-date value.

`@lynx-js/lynx-ui-input` solves the same race by locking the field `readonly` on the main thread while the value round-trips.

## Focus

- `autofocus: true` focuses the field once, when it is created (HTML semantics). Redraws never refocus it.
- `vnode.dom.focus()` and `vnode.dom.blur()` call the native methods. They are safe in `oncreate`: the call travels with the patch that creates the element and runs right after that patch is flushed.
- Called from a timer or a promise, outside any render, the call is sent on its own at the end of the current task.
- Mithril's post-render focus restoration never triggers them (the fake document has no `activeElement`).

Use `autofocus`, not `focus: true`. `focus` is the element's method, and an attribute with that name replaces it.

## `vnode.dom.invoke(method, params)` — any element's UI methods

This is the promise form of `createSelectorQuery().select(...).invoke(...)`, for any element, with no `id`:

```js
const { value, selectionStart } = await field.invoke("getValue");
await scroller.invoke("scrollTo", { offset: 0, smooth: true }); // <scroll-view>
await list.invoke("scrollToPosition", { position: 10 });         // <list>
```

- It resolves with the method's `data`.
- It rejects with an `Error` whose `code`/`data` are native's, or when the element is removed before the call runs.
- `setSelectionRange(start, end)` is a shorthand on fields.

## How it works

`src/fake-dom.js` gives `input`/`textarea` a real `value` property. `focus()`, `blur()` and `invoke()` record two new patch ops:
- `Op.SetInputValue` (`id, value, seq`);
- `Op.InvokeUIMethod` (`id, method, params, callbackId`).

`src/apply-patch.js` queues them and runs them with the main-thread PAPI `__InvokeUIMethod`:
- they run after the patch's `__FlushElementTree()`, then flush once more;
- this is the order ReactLynx's main-thread `Element.invoke()` uses.

Results come back on the forwarded-event channel as a reserved `mithrilLynx:invokeResult` event.

How other frameworks handle this:
- **Vue Lynx** 0.5.1: `v-model` writes a `value` attribute and calls `setValue`, with no race guard.
- **`@lynx-js/lynx-ui-input`**: calls `setValue` from a React effect.
- **ReactLynx core**: no special handling.

## Known limits

- **IME composition:** `e.detail.isComposing` is passed through. A controlled field that *transforms* the text while composing (for example, uppercase during CJK input) will interrupt the composition. Skip the transform while `isComposing` is true.
- **`setValue`'s `cursor` param** (iOS/Android) isn't exposed through `value`. Use `invoke("setValue", { value, cursor })`.
- `<input>`/`<textarea>` need the XElement input artifacts on the Android/iOS host (see mithril-lynx-ui's README); without them the field renders at zero size.
- **`input` fires only when the text changes, as on the web.** Native fires `input` events by itself, and mithril-lynx drops them on the main thread before they reach your handler. Two cases seen on Android:
  - every `setValue` is echoed back as an `input`;
  - a `<textarea>` fires `input ""` (twice) while it is first flushed, before the patch's `setValue` runs.

  Forwarded, the `""` would reach your `oninput` and wipe a controlled field's state. It would also count as a keystroke, so the race guard above would drop the field's initial text. An event that only changes `isComposing` is still forwarded.

## Device verification

Checked on a Samsung SM-A075M (Android), Lynx Go, over `rspeedy dev`:

- **Initial value:** the initial `value` on an `<input>` and on a `<textarea>` shows on first paint, with no `id` or timer.
- **Autofocus:** `autofocus` leaves the caret in the field.
- **Fast typing, plain field:** `adb shell input text` with 37 characters produced the exact text, with no lost characters.
- **Fast typing, uppercase field:** 45 characters, each one round-tripping a `setValue`, came out exactly right, with the caret staying at the end.
- **Clear:** a `value` cleared from a button tap empties the field, and typing afterwards works.
- **mithril-lynx-ui components:** its `Input` (controlled, uppercase: 21 fast characters) and its `TextArea` with `defaultValue` both work. The `TextArea` is the case that exposed the spurious `input ""` above.
- **`getValue`:** `invoke("getValue")` resolves `{ value, selectionStart, selectionEnd, isComposing }`.
- **Focus and blur:** `dom.blur()` / `dom.focus()` hide and show the keyboard (`dumpsys input_method` reports `mInputShown`).
- **No crashes:** no `Fatal signal`.

Unit tests: `test/input.test.ts`.
