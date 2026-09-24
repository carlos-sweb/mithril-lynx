/** Called by `renderApp()` right after it creates its own redraw function.
 * Public so a reusable component library (not just this package's own
 * request.js) can trigger a redraw of whichever app is currently mounted
 * after an async state change (a timer/animation callback, a promise) that
 * didn't happen inside a real event handler — the case mithril-lynx's own
 * auto-redraw-after-event contract doesn't cover. */
export function register(redraw: () => void): void;

/** Clears the current redraw registration (and the pending debounce flag).
 * Fail-fast counterpart to {@link register}: a second `register()` throws,
 * so call this on teardown or full reload before mounting a new app. */
export function unregister(): void;

/** Overrides the debounce delay `redraw()` uses (default 50ms — see the
 * `mount-redraw.js` header for why it is an empirical margin, not a
 * scheduling guarantee). */
export function configure(options?: { redrawDelayMs?: number }): void;

/** No-op before any app has mounted. Scheduled, not synchronous — see
 * mount-redraw.js's own header for why a synchronous call here would race
 * a caller's own pending `.then()`/callback that hasn't stored its result
 * yet. */
export function redraw(): void;
