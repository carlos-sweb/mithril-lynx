# `mithril-lynx-v2/route`

`m.route`, reimplemented for an environment with no URL bar and no `window.history` — Lynx pages aren't URL-addressable, so there's nothing for a real `popstate`-based router to hook into. This is not a limitation specific to Mithril: it's why React Router ships `MemoryRouter` and Vue Router ships `createMemoryHistory()` for exactly this kind of environment. `route.js` follows the same pattern — an in-memory array standing in for the browser's session history — while keeping the rest of the real `m.route` API shape, so route-using view code doesn't need to be rewritten, just re-imported.

```js
import route from "mithril-lynx-v2/route";
```

## Setup

```js
route("/", {
  "/": Home,
  "/detail/:id": Detail,
});
```

Unlike real Mithril, this call takes no `root` DOM argument — v2 has exactly one `renderApp()` for the app's whole lifetime (see the main README's architecture section), so `route(...)` calls it internally the first time a route resolves. `defaultRoute` (`"/"` above) is both the fallback for an unmatched path **and** the screen the app starts on — there's no browser URL to read an initial path from, so this is the Lynx equivalent of React Router's `initialEntries={["/"]}`.

Route values can be a plain component, or a resolver object with `onmatch`/`render`, exactly like real Mithril:

```js
route("/", {
  "/": Home,
  "/settings": {
    onmatch: (params) => requiresAuth() ? SettingsPage : route.SKIP,
    render: (vnode) => m(Layout, vnode),
  },
});
```

`route.SKIP` falls through to the next matching route, same as upstream.

## Navigating

```js
route.set("/detail/:id", { id: 42 });   // pushes a new history entry
route.set("/detail/:id", { id: 42 }, { replace: true }); // overwrites the current one
route.get();                             // current resolved path, e.g. "/detail/42"
route.param("id");                       // "42" — or route.param() for the whole params object
```

`route.back()` / `route.forward()` walk the same in-memory history stack `route.set` writes to. **These do not exist on real Mithril** — they're new here because Lynx has no hardware/gesture "back" button exposed to JS (only app-lifecycle events like `onAppEnterBackground`, not navigation), so an app's own back affordance has to call something explicit. Wire a screen's back button to `route.back()`.

`route.prefix` exists only so app code defensively ported from a real Mithril app (`m.route.prefix = ""`) doesn't throw on import — there's no URL bar for a prefix to apply to, so setting it does nothing.

## Links

Lynx has no `<a>`/`onclick` — `route.Link` renders a tap-driven element instead (the same shape ReactLynx's `useNavigate()` + `ontap` pattern and Vue Lynx's custom `RouterLink` slot use):

```js
m(route.Link, { href: "/detail/:id", params: { id: 42 } }, [
  m("text", null, "Go to detail"),
]),
```

- `selector` picks the rendered tag (default `"view"`).
- `params` interpolates into `href` the same way `route.set`'s second argument does.
- `options` is passed straight through to the underlying `route.set` call (e.g. `{ replace: true }`).
- `disabled: true` renders the element with no `ontap` at all, rather than an `ontap` that no-ops.
- Your own `ontap` still runs first; returning `false` from it cancels the navigation (matches real Mithril's `m.route.Link` behavior).

## Known differences from real `m.route`

- No `root` argument to the setup call (see "Setup" above) — architectural, not an oversight.
- `route.back()`/`route.forward()` are new additions, not part of the real `m.route` API — see "Navigating" above for why Lynx needs them.
- History is in-memory only: it does not survive a full app restart, and there is no deep-linking from outside the app (nothing external can set the initial path — it's always `defaultRoute`).

## Device verification

Navigation (Home → Detail with param interpolation, `route.Link` taps, `back()`/`forward()`), hot-reload while sitting on a non-default route (`module.hot.accept` + `route.set(route.get(), null, { replace: true })` to re-resolve after swapping a screen module), and confirmation that navigating away tears down the previous screen's nodes cleanly (via real patch ops — `Op.RemoveChild`/`Op.CreateElement`, not comparing CDP node ids, which are not stable identity across separate `DOM.getDocument()` calls) are all covered on a real connected Android device. See `.omo/plans/m-route-en-memoria.md` §4–§6 for the full research (how React Native/Vue-on-Lynx handle navigation) and the device evidence.
