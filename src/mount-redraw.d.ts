/** Called by `renderApp()` right after it creates its own redraw function.
 * Public so a reusable component library (not just this package's own
 * request.js) can trigger a redraw of whichever app is currently mounted
 * after an async state change (a timer/animation callback, a promise) that
 * didn't happen inside a real event handler — the case mithril-lynx's own
 * auto-redraw-after-event contract doesn't cover. */
export function register(redraw: () => void): void;

/** No-op before any app has mounted. Scheduled, not synchronous — see
 * mount-redraw.js's own header for why a synchronous call here would race
 * a caller's own pending `.then()`/callback that hasn't stored its result
 * yet. */
export function redraw(): void;
