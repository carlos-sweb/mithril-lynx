# `mithril-lynx/route`

`m.route`, reimplemented for an environment with no URL bar and no `window.history`. Lynx pages aren't URL-addressable, so there's nothing for a `popstate`-based router to hook into — which is why ReactLynx's documented routers do the same thing: React Router with `MemoryRouter`, TanStack Router with `createMemoryHistory()`. `route.js` keeps history in an in-memory array and otherwise follows the real `m.route` API and behavior (Mithril 2.3.8), so route-using view code only needs to be re-imported. [`ROUTE_CONTRACT_ANALYSIS.md`](./ROUTE_CONTRACT_ANALYSIS.md) has the full parity table.

```js
import route from "mithril-lynx/route";
```

**Changed in 3.0.0:**
- **Breaking:** `route.set()` is asynchronous, as in Mithril (see "Navigating").
- A changed `:key` param recreates the page.
- `options.state` is supported.
- `route.Link` runs its lifecycle hooks once, honors `e.preventDefault()` and accepts a `{ handleEvent }` object.
- `route.get()` returns the decoded path.
- New: `route.canGoBack()` and `route.listenBackButton()` (see "Android back button").

[`ROUTE_CONTRACT_ANALYSIS.md`](./ROUTE_CONTRACT_ANALYSIS.md) has the details.

## Setup

```js
route("/", {
  "/": Home,
  "/detail/:id": Detail,
});
```

Unlike real Mithril, this call takes no `root` DOM argument — this package has exactly one `renderApp()` for the app's whole lifetime, so `route(...)` calls it internally the first time a route resolves. `defaultRoute` (`"/"` above) is required: it's both the fallback for an unmatched path **and** the screen the app starts on (there's no browser URL to read an initial path from — the Lynx equivalent of React Router's `initialEntries={["/"]}`).

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

`route.SKIP` falls through to the next matching route. Route templates follow upstream's rules: they must start with `/`, and params must be separated by `/`, `.` or `-` (`/:a:b` throws a `SyntaxError`). A `:key` param works as in Mithril: when it changes, the page is recreated with fresh state.

## Navigating

```js
route.set("/detail/:id", { id: 42 });                     // pushes a new history entry
route.set("/detail/:id", { id: 42 }, { replace: true });  // overwrites the current one
route.set("/detail/:id", { id: 42 }, { state: { from: "home" } }); // state is merged into params
route.get();        // current path, decoded, e.g. "/detail/42"
route.param("id");  // "42" — or route.param() for the whole params object
```

**`route.set()` is asynchronous, like `m.route`:** the history changes right away, but the new screen resolves on the next microtask, and several navigations in the same tick resolve only the last one. `route.get()` still returns the previous path until then. This is what makes a redirect from inside a render safe (e.g. `route.set("/login")` in a page's `oninit`).

`options.state` is stored with the history entry, merged into the route's params, and restored by `back()`/`forward()`. `options.title` is accepted and ignored.

`route.back()` / `route.forward()` walk the same in-memory history. **These are not part of `m.route`** — there's no browser back button. Both return `true` when they navigated and `false` at the start/end of the stack, and `route.canGoBack()` tells whether `back()` would navigate, so a back affordance can enable itself.

`route.prefix` exists only so code ported from a real Mithril app (`m.route.prefix = ""`) doesn't throw; it has no effect.

## Android back button

The system back button doesn't reach JS on its own (Lynx only exposes it inside an `<overlay>`, through `bindrequestclose`), so by default pressing back closes the app from any screen. `route.listenBackButton()` connects it, opt-in, through the same channel apps already use for host → JS events (`sendGlobalEvent` → `GlobalEventEmitter`):

1. The host sends a global event when back is pressed, from an `OnBackPressedCallback` that starts **disabled**.
2. JS calls `route.back()` when the event arrives.
3. JS tells the host whether there's history to go back to (`onCanGoBackChange`); the host enables its callback only while there is. At the first screen the callback is disabled, so Android's default (closing the app) applies.

Nothing blocks when this isn't set up: without the host part, the event never arrives; without the JS part, the callback stays disabled; without `GlobalEventEmitter`, it logs a warning and does nothing.

**JS** (e.g. in `background.ts`, after `route(...)`):

```js
route.listenBackButton({
  // eventName: "mithrilLynx:back",  // the default
  onCanGoBackChange: (canGoBack) => NativeModules.NavModule?.setCanGoBack(canGoBack),
});
```

It returns a function that stops listening (useful for HMR).

**Android host** (Kotlin):

```kotlin
// MainActivity.kt
import androidx.activity.OnBackPressedCallback
import com.lynx.react.bridge.JavaOnlyArray

class MainActivity : AppCompatActivity() {
    companion object {
        // Disabled until JS reports there is history to go back to.
        var backCallback: OnBackPressedCallback? = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val builder = LynxViewBuilder()
        builder.registerModule("NavModule", NavModule::class.java)
        val lynxView = builder.build(this)
        // ... load the bundle, setContentView(lynxView)

        val callback = object : OnBackPressedCallback(false) {
            override fun handleOnBackPressed() {
                lynxView.sendGlobalEvent("mithrilLynx:back", JavaOnlyArray())
            }
        }
        onBackPressedDispatcher.addCallback(this, callback)
        backCallback = callback
    }

    override fun onDestroy() {
        backCallback = null
        super.onDestroy()
    }
}
```

```kotlin
// NavModule.kt
import android.content.Context
import android.os.Handler
import android.os.Looper
import com.lynx.jsbridge.LynxMethod
import com.lynx.jsbridge.LynxModule

class NavModule(context: Context) : LynxModule(context) {
    @LynxMethod
    fun setCanGoBack(canGoBack: Boolean) {
        // Called from the JS thread; the callback must be touched on the UI thread.
        Handler(Looper.getMainLooper()).post { MainActivity.backCallback?.isEnabled = canGoBack }
    }
}
```

Because the callback is only enabled while there's history, this also works with Android's predictive back gesture.

## Links

Lynx has no `<a>`/`onclick` — `route.Link` renders a tap-driven element instead (the same shape as ReactLynx's `useNavigate()` + `bindtap` pattern):

```js
m(route.Link, { href: "/detail/:id", params: { id: 42 } }, [
  m("text", null, "Go to detail"),
]),
```

- `selector` picks the rendered tag (default `"view"`).
- `params` interpolates into `href` the same way `route.set`'s second argument does.
- `options` is passed straight through to the underlying `route.set` call (e.g. `{ replace: true }`).
- `disabled: true` renders the element with no `ontap` at all.
- Your own `ontap` runs first (a function or a `{ handleEvent }` object); returning `false` from it, or calling `e.preventDefault()`, cancels the navigation.
- `key` and lifecycle hooks (`oncreate`, …) stay on the Link itself and aren't copied onto the rendered element, as in upstream.

## Known differences from real `m.route`

- No `root` argument to the setup call, and `defaultRoute` is required (see "Setup").
- `onclick` on a Link is `ontap` here (Lynx's tap event).
- `back()`, `forward()`, `canGoBack()` and `listenBackButton()` are additions.
- `route.prefix` has no effect; `options.title` is ignored.
- History is in-memory only: it doesn't survive an app restart.
- **Deep links aren't supported yet.** The host *can* pass data to a page (`initData` at `loadTemplate`, `updateData`, `globalProps`), but `route` doesn't read an initial path from it — the app always starts at `defaultRoute`. Tracked in `ROUTE_CONTRACT_ANALYSIS.md`.

## Device verification

Navigation (Home → Detail with param interpolation, `route.Link` taps, `back()`/`forward()`), hot-reload while sitting on a non-default route (`module.hot.accept` + `route.set(route.get(), null, { replace: true })` to re-resolve after swapping a screen module), and confirmation that navigating away tears down the previous screen's nodes cleanly (via real patch ops, not CDP node ids, which are not stable identity across separate `DOM.getDocument()` calls) were covered on a real Android device before 3.0.0. The asynchronous `set()`, the parity fixes and `listenBackButton()` are covered by unit tests (`test/route.test.ts`). The back button was checked on the same device with a real app (`non-contact`, a debug build wired as in "Android back button" above): back on the first screen closes the app, back on a pushed screen returns to the previous one, and an in-app `route.back()` updates `canGoBack` so the next system back closes the app.
