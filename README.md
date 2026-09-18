# mithril-lynx-v2

Mithril.js rendered through [Lynx](https://lynxjs.org)'s Element PAPI, with genuine automatic redraw and three real reload modes — the two things [`mithril-lynx`](../mithril-lynx) (v1) never fully got right.

> **Note:** this repo is a complete, from-scratch rewrite of the previous version, not an incremental patch on top of it. v1 is left intact, read-only, as a reference — no more fixes land there. See "Why a rewrite" below for exactly what justified starting over instead of patching v1 again.

## Why a rewrite

v1's core bugs all traced back to the same root cause: whether a redraw actually reached the main thread depended on runtime conditions (`typeof globalThis.__FlushElementTree === "function"`, which render mode was active, load order) instead of a fixed contract. Every fix added another conditional on top of the last one. Reading ReactLynx's own source (not just its docs) showed its actual patch-channel/reload design is a different architecture, not an incremental improvement on v1's — so v2 starts over with that contract from the first commit:

- **One thread model, not three.** v1 had main-thread-owned, data-channel, and renderer modes. v2 has exactly one: the real `mithril/render/render.js` (via [`mithril-runtime`](https://github.com/carlos-sweb/mithril-runtime)) always runs on the **background** thread against a virtual tree; the **main thread** only ever replays patches onto real Element PAPI nodes and forwards native events back. No app view code ever runs on the main thread.
- **One explicit commit hook, not a conditional global.** `src/commit.js` installs exactly one commit callback per `renderApp()` lifetime, set up once by the code that owns the render. Asking to commit before one is installed throws immediately, on the same tick, with a message naming exactly what's missing — never a silently frozen screen.
- **Three reload modes, correctly separated** (see `.omo/plans/mithril-lynx-v2-desde-cero.md` for the full device-verified story):
  - **A — data reload**: text/props/CSS edits. Already validated in v1; rebuilt on the new core.
  - **B — structural reload**: adding/removing/reordering tree nodes. v1 assumed this *had* to be a full reload; v2 lets Mithril's own real diff (running in the background against a real tree) produce the right Create/Insert/Remove ops instead — no separate wire-protocol mode needed, just reconciliation that doesn't discard nodes that didn't change.
  - **C — full reload**: fallback for what A/B can't resolve (new imports, changed dependencies, an unrecoverable error). Same CDP `Page.reload` mechanism v1 stabilized in 0.0.9, rewritten on the new core.

**Deliberately not carried over from v1 (yet)**: gestures, list virtualization (Tier 2), the imperative ref helpers, and v1's stack-based `mithril-lynx/navigation`. Those were real, device-verified capabilities in v1 (see `mithril-lynx/CONTRACT.md` / `DEVICE_VERIFICATION.md`) — v2's scope so far is specifically the redraw/reload core plus routing and networking (see below). Reimplementing the rest on the v2 core is future work, not something this rewrite claims to already cover.

## Usage

`main-thread.ts`:

```js
import { setupRenderer } from "mithril-lynx-v2/main-thread";

setupRenderer();
```

`background.ts`:

```js
import { renderApp } from "mithril-lynx-v2/background";
import m from "mithril-runtime";

let count = 0;
const Counter = {
  view: () => m("text", { ontap: () => { count += 1; } }, String(count)),
};

renderApp({ root: () => m(Counter) });
```

`setupRenderer()` needs no app-specific code — it's generic, wired once via `mithril-lynx-v2/plugin` (the Rspeedy/Rsbuild plugin building the two-bundle main-thread/background app). All app logic, including the whole Mithril component tree, lives in `background.ts`. A tap handler that mutates state repaints the screen with **no explicit `redraw()` call anywhere in the view** — real Mithril's own `render(dom, vnodes, redraw)` contract does that automatically after any event, the same mechanism `@lynx-js/react` relies on (see `test/end-to-end.test.ts` for this exact scenario running against real Lynx PAPI via `@lynx-js/testing-environment`, not a mock).

`mithril-runtime` — not the official `mithril` package — is the `peerDependency` here: a maintained fork with `m.route`/`m.trust`/`m.request` stripped at the source (see its own README for why), since those three need Lynx-specific replacements anyway (routing and networking below; `m.trust` has no replacement — see "Known gaps").

## Routing

`m.route`, reimplemented as in-memory history (Lynx has no URL/`window.history` for a real one to hook into) while keeping the rest of the real `m.route` API shape. See [`ROUTE.md`](./ROUTE.md) for the full API and usage.

## Networking

`m.request`, reimplemented as a wrapper over Lynx's own `fetch`. See [`REQUEST.md`](./REQUEST.md) for the full API, and [`FETCH_INVESTIGATION.md`](./FETCH_INVESTIGATION.md) for the complete option-by-option gap analysis against the real `m.request` spec, backed by real-device evidence rather than docs/types alone (which were wrong twice during that investigation).

## Known gaps

- **`m.trust`** — not present. Stripped from `mithril-runtime` at the source, and Lynx's Element PAPI has no innerHTML-equivalent injection point to reimplement it against anyway (same permanent gap v1 documented).
- **A handful of `m.request` options with no `fetch` equivalent** (`config`, `async: false`, `user`/`password`, `withCredentials`) throw immediately with a message pointing at `FETCH_INVESTIGATION.md`, rather than silently behaving differently — see `REQUEST.md`.

## Testing

```bash
npm test
```

Runs against `@lynx-js/testing-environment`'s real Element PAPI simulation via `rstest` — `test/end-to-end.test.ts` and `test/structural-reload.test.ts` exercise real Mithril diff + real patch replay, not mocks. Device-only claims (focus/text surviving a structural reload on a real `<input>`, the three reload modes triggering correctly over a live dev session) are verified separately on a connected Android device and logged in `.omo/plans/mithril-lynx-v2-desde-cero.md` §8, not re-asserted here.

## Reference docs

- `.omo/plans/mithril-lynx-v2-desde-cero.md` — the full rewrite plan: architecture decisions, the three reload modes' device verification, and the postmortem on exactly what v1 got wrong.
- `.omo/plans/m-route-en-memoria.md` — how `m.route` was designed and verified for an in-memory, URL-less environment.
- `.omo/plans/m-request-fetch-lynx.md` — the `m.request`-vs-`fetch` investigation plan and its execution log.
- [`ROUTE.md`](./ROUTE.md), [`REQUEST.md`](./REQUEST.md), [`FETCH_INVESTIGATION.md`](./FETCH_INVESTIGATION.md) — user-facing reference docs for the two Lynx-specific reimplementations.
