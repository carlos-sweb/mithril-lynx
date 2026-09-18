// src/mount-redraw.js
//
// A minimal version of real Mithril's `api/mount-redraw.js`: a shared
// singleton so `request.js` can trigger a redraw of whichever app is
// currently mounted, without needing a direct reference to that specific
// `renderApp()` call's handle. `background.js` registers its own
// `performRender` here right after creating it; `route.js` could too, but
// doesn't need to (it already redraws itself directly on every
// navigation) — this module exists specifically so `request.js` isn't
// coupled to "did this app mount via route() or a plain renderApp() call".
//
// Deliberately NOT a queue/pubsub of multiple mounted apps (real Mithril's
// mount-redraw.js supports that because a browser page can `m.mount()`
// several independent roots) — mithril-lynx-v2 has exactly one `renderApp()`
// for the app's whole lifetime (plan §3.1), so "the current redraw
// function" is a single slot, not a list.
//
// `redraw()` schedules instead of calling `currentRedraw()` inline — same
// reason real Mithril's version schedules through the platform's
// requestAnimationFrame instead of rendering synchronously: `request.js`'s
// own `promise.then(onSuccess)` calls this BEFORE the caller's own
// `.then()` runs (that callback is chained onto `request()`'s *returned*
// promise, one microtask hop further back) — a synchronous redraw here
// would render the screen one tick too early, before the caller has stored
// the response in its own state.
//
// DEVICE-CONFIRMED LYNX QUIRK (see FETCH_INVESTIGATION.md): unlike a spec
// browser, where a macrotask (rAF, setTimeout) is guaranteed to run only
// after every currently-queued microtask (including ones enqueued by other
// microtasks) has drained, on this Lynx background-thread runtime BOTH
// `lynx.setTimeout(fn, 0)` and `lynx.requestAnimationFrame(fn)` fire before
// even the FIRST pending microtask — confirmed with a Promise chain logging
// three chained `.then()`s against a 0ms/1ms/4ms/16ms timer and against
// `requestAnimationFrame`: the timer/rAF callback always logged first. A
// 50ms delay was the first value that reliably let a single `.then()`
// (the realistic caller shape: `request(url).then(cb)`) run first. There is
// no known Lynx primitive that defers "until microtasks finish" the way a
// spec-compliant macrotask does — this delay is an empirical safety margin,
// not a scheduling guarantee.
const REDRAW_DELAY_MS = 50;

let currentRedraw = null;
let pending = false;

function schedule(fn) {
	const timer = typeof lynx !== "undefined" && typeof lynx.setTimeout === "function" ? lynx.setTimeout.bind(lynx) : setTimeout;
	timer(fn, REDRAW_DELAY_MS);
}

export function register(redraw) {
	currentRedraw = redraw;
}

/** What `request.js` calls after a non-background request resolves. A
 * no-op before any app has mounted — a request kicked off before
 * renderApp()/route() ran has nothing to redraw yet, which isn't
 * necessarily a bug the way calling commit() before mounting is. Multiple
 * calls within the delay window collapse into a single scheduled render,
 * same debounce real Mithril's `redraw()` does with its `pending` flag. */
export function redraw() {
	if (pending) return;
	pending = true;
	schedule(() => {
		pending = false;
		if (currentRedraw != null) currentRedraw();
	});
}
