# Changelog

## 3.0.0

Everything since 2.6.2.

### Breaking changes

- **Native `<list>`:** `list` and `list-item` are ordinary Mithril elements. The `Op.CreateList`/`Op.SetListItems` protocol and the `mithril-lynx/list-cell` / `mithril-lynx/list-support` entry points are gone. Render `m("list", …, items.map((it) => m("list-item", { key: it.id, "item-key": it.id }, …)))` instead. See the README.
- **`route.set()` is asynchronous,** as in Mithril's `m.route`. The history changes right away, but the new screen resolves on the next microtask, and `route.get()` returns the previous path until then. Several `set()` calls in the same tick resolve only the last one.
- **`route(defaultRoute, routes)` requires `defaultRoute`** and throws a `TypeError` without it. Route templates with badly separated params (`/:a:b`) throw a `SyntaxError`, as upstream does.
- **Native events on `<input>`/`<textarea>`:** an `input` event that doesn't change the text is no longer forwarded. That covers native's echo of `setValue`, and the `input ""` a `<textarea>` fires on creation. `input` now means "the text changed", as on the web.
- **The patch protocol is now `0x4d4e`:** the main-thread and background bundles must be rebuilt together.

### New

- **`<input>` / `<textarea>`:**
  - `value` works like the web's controlled input: sent with the native `setValue` only when it differs from the field, never echoing typed text, and guarded against racing keystrokes.
  - `autofocus` focuses the field once, on creation.
  - See [`INPUT.md`](./INPUT.md).
- **Native UI methods on any element:** `vnode.dom.invoke(method, params)` returns a promise, and `vnode.dom.focus()` / `vnode.dom.blur()` call the native methods. They run on the main thread right after the patch's flush, so they're safe from `oncreate`, with no `id`, `setTimeout` or selector query (new ops `Op.InvokeUIMethod`, `Op.SetInputValue`).
- **Native `<list>`:**
  - every `<list>` / `<list-item>` attribute is passed with its real type (`src/list-attributes.js`);
  - items are attached only when native asks for them (`src/list-runtime.js`, a port of @lynx-js/react's element-template list);
  - verified on device up to ~2,000 items.
- **`route`:**
  - `options.state`;
  - a changed `:key` param recreates the page;
  - `route.canGoBack()`;
  - `route.listenBackButton()` for an opt-in Android back button, with a Kotlin host recipe in [`ROUTE.md`](./ROUTE.md).
- **`mithril-lynx/testing`:** a stand-in for `__InvokeUIMethod`, plus `uiMethodCalls` and `setUIMethodResponder()`.

### Fixes

- **`route.Link`:** runs its lifecycle hooks once, honors `e.preventDefault()` and `{ handleEvent }` listeners, and doesn't copy `key`/hooks onto the rendered element.
- **`route` redirects:** a redirect from inside a render (`route.set()` in `oninit`) no longer throws "Node is currently being rendered to".
- **`route.get()`:** returns the decoded path.
- **Removed subtrees:** release every descendant's bookkeeping on both threads, where before only the root's was released.
- **Gesture worklets:** unregistered when their detector or element goes away.
- **Clearing a whole style** (`style` removed, or replaced by a string) expands into per-property removals.
- **List removals:** a removed on-screen list item is detached only after native processed its removal (a device-verified crash fix).

### Performance

- The automatic redraw after a high-frequency event (`gesturemove`, `touchmove`, `scroll`) is coalesced to one per frame. Every handler still runs.

### Known gaps

- `<list update-animation="default">` is not safe on lists that remove on-screen items — see [`UPDATE_ANIMATION_GAP.md`](./UPDATE_ANIMATION_GAP.md).
- `route` has no deep-link support (an initial path from the host) yet.
