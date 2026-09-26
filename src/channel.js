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

import { PROTOCOL_VERSION } from "./patch-protocol.js";

/**
 * Background thread: ship one commit's ops to the main thread.
 *
 * The patch is prefixed with `PROTOCOL_VERSION` so the main thread can
 * detect a stale/desynced bundle (partial HMR, cache) and fail loudly
 * instead of re-interpreting reordered opcodes against the shared id space.
 * @param {unknown[]} ops - The flat op array for one commit.
 * @returns {void}
 */
export function sendPatchToMainThread(ops) {
	lynx.getCoreContext().dispatchEvent({ type: patchEventName, data: [PROTOCOL_VERSION, ...ops] });
}

/** Background thread: receive a forwarded native event `{ id, type, payload, seq? }`
 * (`seq`: see apply-patch.js's `fields`), or an Op.InvokeUIMethod result
 * (`type` = `INVOKE_RESULT_EVENT`, see patch-protocol.js).
 * @param {(event: {data: {id: number, type: string, payload: unknown, seq?: number}}) => void} handler - Called for every forwarded event.
 * @returns {void}
 */
export function onEventFromMainThread(handler) {
	lynx.getCoreContext().addEventListener(eventFromMainThreadEventName, handler);
}

/** Main thread: receive a patch (an ops array) from the background thread.
 * @param {(event: {data: unknown}) => void} handler - Called with each version-prefixed patch.
 * @returns {void}
 */
export function onPatchFromBackground(handler) {
	lynx.getJSContext().addEventListener(patchEventName, handler);
}

/** Main thread: forward a native event on element `id` back to the background thread.
 * @param {number} id - The element id.
 * @param {string} type - The event type.
 * @param {unknown} payload - The native event payload.
 * @param {number} [seq] - For an <input>/<textarea>, its native `input` event count.
 * @returns {void}
 */
export function sendEventToBackground(id, type, payload, seq) {
	const data = seq === undefined ? { id, type, payload } : { id, type, payload, seq };
	lynx.getJSContext().dispatchEvent({ type: eventFromMainThreadEventName, data });
}
