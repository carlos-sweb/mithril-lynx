// src/channel.js
//
// The cross-thread transport (F0.1's decision, plan §3.2). Uses the exact
// same mechanism mithril-lynx v1's already-on-device-verified renderer mode
// used (`lynx.getCoreContext()`/`lynx.getJSContext()` event pub/sub with a
// namespaced event name) rather than the untested `lynx.triggerLepusGlobalEvent`
// candidate F0.1 turned up — that candidate is real and worth trying in a
// later iteration (see the plan's §8 F0.1 note), but shipping a first real
// device build on a validated channel was the priority for F3, not
// re-verifying the channel choice from scratch.
//
// Naming note: `getCoreContext()` (called from the background thread) and
// `getJSContext()` (called from the main thread) are two different global
// accessors for the SAME underlying native pub/sub context — confirmed by
// v1's renderer/background.js and renderer/main-thread.js dispatching to
// and listening on each other via exactly this pairing.

export const patchEventName = "MithrilLynx:Patch";
export const eventFromMainThreadEventName = "MithrilLynx:Event";
export const renderPageEventName = "__RenderPage";
export const destroyLifetimeEventName = "__DestroyLifetime";

/** Background thread: ship one commit's ops to the main thread. */
export function sendPatchToMainThread(ops) {
	lynx.getCoreContext().dispatchEvent({ type: patchEventName, data: ops });
}

/** Background thread: receive a forwarded native event `{ id, type, payload }`. */
export function onEventFromMainThread(handler) {
	lynx.getCoreContext().addEventListener(eventFromMainThreadEventName, handler);
}

/** Main thread: receive a patch (an ops array) from the background thread. */
export function onPatchFromBackground(handler) {
	lynx.getJSContext().addEventListener(patchEventName, handler);
}

/** Main thread: forward a native event on element `id` back to the background thread. */
export function sendEventToBackground(id, type, payload) {
	lynx.getJSContext().dispatchEvent({ type: eventFromMainThreadEventName, data: { id, type, payload } });
}
