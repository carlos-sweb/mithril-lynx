# `mithril-lynx/request`

`m.request`, reimplemented as a wrapper over Lynx's own `fetch` — real `m.request` is built on `XMLHttpRequest`, which doesn't exist on Lynx. The gap between the two turned out smaller than the installed `@lynx-js/types` suggested; the full option-by-option comparison, with real-device evidence for every claim (not just docs/types, both of which were wrong at least once during that investigation), lives in [`FETCH_INVESTIGATION.md`](./FETCH_INVESTIGATION.md). This file is the practical usage doc; that one is the research record.

```js
import request from "mithril-lynx/request";
```

## Basic usage

```js
request("/users/:id", { params: { id: 42 } })
  .then((user) => { /* ... */ });
```

Matches real `m.request`: GET by default, `:param` interpolation in the URL (reusing `mithril-runtime/pathname/build.js`, the same engine `route.js` uses), automatic redraw of the currently mounted app once the request settles — unless `background: true` is passed, same as upstream.

## Supported options

| Option | Behavior |
|---|---|
| `method`, `url`, `params` | Same as real `m.request`. |
| `body` (plain object) | JSON-encoded; `Content-Type: application/json; charset=utf-8` set automatically unless you already set one. |
| `body` (`URLSearchParams`) | Passed through unchanged — Lynx's `fetch` sets `Content-Type: application/x-www-form-urlencoded` automatically, confirmed on device. |
| `headers` | Plain object, same as upstream. |
| `responseType: "json" \| "text"` | Same as upstream (no `"blob"`/`"document"` — see below). |
| `serialize` / `deserialize` | Same as upstream. |
| `extract` | `(response, options) => any` — bypasses the status check entirely, same as upstream's `(xhr, options) => any`. Signature changes (`response` instead of `xhr`) since there's no XHR object; the purpose is identical. |
| `type` | Constructor applied to the result, unchanged from upstream. |
| `timeout` | Real cancellation, not just giving up on waiting — backed by `AbortController`, confirmed on device to actually tear down the in-flight connection (aborting 800ms into a 5-second server-side delay rejected at ~805ms, not 5000ms). |
| `signal` | `AbortSignal` — linked into the request's own `AbortController`, so a caller-provided signal aborts the request exactly like `.abort()`/`timeout`. Not part of real `m.request` (which only reached `xhr.abort()` via `config`); a natural addition here for the same reason `.abort()` is. |
| `background` | Same as upstream: skip the automatic redraw. |
| `.abort()` | **Not part of real `m.request`'s API** — a bonus method on the returned promise, since Lynx's `AbortController` makes it a real, working cancellation (real `m.request` only exposes this indirectly, through `config(xhr) => xhr.abort()`, which has no equivalent here — see below). |

## Explicitly unsupported (throws immediately, never silently different)

These have no `fetch` equivalent on Lynx. Passing any of them throws right away, with a message pointing back at `FETCH_INVESTIGATION.md`, rather than quietly behaving differently from what real `m.request` would do:

- **`config(xhr)`** — `fetch` gives no live request object to mutate mid-flight.
- **`body` as `FormData`** — confirmed absent on Lynx at runtime (`typeof FormData === "undefined"`). Restructure as JSON, or a `URLSearchParams` body if the server accepts form-encoding.
- **`user` / `password`** (inline Basic Auth) — Lynx has no `btoa`, so there's no way to build the `Authorization` header even by hand.
- **`withCredentials`** — Lynx has no CORS/origin model for this to apply to.
- **`async: false`** — no synchronous `fetch` exists anywhere, browser or Lynx.

`responseType: "blob"` / `"document"` aren't in the throw-list above because they're not meaningfully requestable in the first place: Lynx's `Body` has no `.blob()`, and `"document"` has no meaning outside a browser DOM.

## Error shape

`err.code` (the HTTP status) and `err.response` (the already-parsed body) match real `m.request` on a non-2xx response:

```js
request("/missing").catch((err) => {
  err.code;      // response.status
  err.message;   // response.statusText, unless the parsed body is a plain string
  err.response;  // the already-parsed body
});
```

**One small divergence to be aware of:** real `m.request` sets `err.message` to the raw `responseText` (the body as-is), whereas this wrapper uses `response.statusText` unless the parsed body happens to be a string. `fetch`'s `Response` is single-use — once `.json()` has consumed it, the raw text is gone — so matching upstream's raw-body message would require reading the body as text first; that's not done here. See `FETCH_INVESTIGATION.md` for the full option-by-option comparison.

## Testing

Two separate layers, deliberately not mixed:

- **Unit tests** (`test/request.test.ts`, run via `npm test`) inject a fake `fetch` via `createRequestor(fetchImpl)` — they validate the wrapper's own logic (URL building, body encoding, the unsupported-option throws, the redraw timing below) without touching the network.
- **The underlying `lynx.fetch` primitive itself** — redirects, `AbortController`, `URLSearchParams` bodies, `Headers` case-sensitivity — is validated separately against a real device and a real server, documented with the raw evidence in `FETCH_INVESTIGATION.md`.

`createRequestor()` is also there for any app that wants its own singleton (e.g. pointed at a different fake for a specific test file); `import request from "mithril-lynx/request"` is the default singleton for normal app use, matching real `m.request`'s feel.

## A Lynx timer quirk this module works around

The automatic redraw after a request resolves is **scheduled**, not synchronous — calling it inline would repaint the screen *before* your own `.then()` callback (which is what actually stores the response in your app's state) gets to run, since that callback is chained one microtask behind `request()`'s internal one. Real Mithril sidesteps the exact same ordering issue by deferring its own redraw through `requestAnimationFrame`, which in a spec-compliant browser is guaranteed to run only after every pending microtask (including yours) has drained.

**Confirmed on a real device: Lynx's `lynx.setTimeout`/`lynx.requestAnimationFrame` do not honor that guarantee** — a scheduled callback fired *before* a chain of pending `.then()`s in every delay tested (0ms up to 16ms). This module works around it with an empirically-chosen 50ms delay, which is a safety margin, not a scheduling guarantee. See `FETCH_INVESTIGATION.md` §4.6 for the raw evidence and exact test code. If you build your own async-then-redraw logic anywhere else in an app using this framework, the same caveat applies.
