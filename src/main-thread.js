// src/main-thread.js
//
// Entry point for the main thread (Lepus VM). Never runs Mithril or any app
// view code (see background.js's header, plan §3.1) — only replays patches
// from the background thread onto real Element PAPI, and forwards native
// events back. Structure ported from mithril-lynx v1's
// renderer/main-thread.js (setupRenderer()), which already validated this
// exact __RenderPage/__DestroyLifetime timing and patch-buffering behavior
// on a real device (mithril-lynx/DEVICE_VERIFICATION.md) — that plumbing
// was never part of the bug this rewrite exists to fix.

import { createPatchApplier } from "./apply-patch.js";
import { PROTOCOL_VERSION } from "./patch-protocol.js";
import {
	destroyLifetimeEventName,
	onPatchFromBackground,
	renderPageEventName,
	sendEventToBackground,
} from "./channel.js";

// The native engine unconditionally invokes a global `processData(initData)`
// hook on every __RenderPage — found missing here via real-device testing
// in mithril-lynx v1 (its main-thread.js already had this fix; its
// renderer/main-thread.js needed it too). Required regardless of framework.
Object.assign(globalThis, {
	processData: (data) => data,
});

/**
 * Call once, at main-thread.ts's top level. Waits for `__RenderPage` to
 * create the real page (the background thread's own initial render may
 * finish before or after that fires — patches arriving early are buffered
 * and replayed in order once the page exists), then wires the patch/event
 * channel for the lifetime of the page.
 * @returns {void}
 */
export function setupRenderer() {
	const engine = lynx.getEngine();
	let applier = null;
	let pageReady = false;
	let pendingPatches = [];

	/**
	 * Receives a patch, validating its protocol version and buffering it until the page exists.
	 * @param {{data: unknown}} event - The patch event.
	 * @returns {void}
	 * @throws {Error} On a protocol version mismatch.
	 */
	const onPatch = (event) => {
		const data = event.data;
		if (!Array.isArray(data) || data[0] !== PROTOCOL_VERSION) {
			throw new Error(
				`[mithril-lynx] patch protocol mismatch: expected version ${PROTOCOL_VERSION}, ` +
					`got ${Array.isArray(data) ? String(data[0]) : typeof data}. ` +
					"This is always a stale/desynced bundle (partial HMR or a cached main-thread chunk) — " +
					"rebuild both bundles together.",
			);
		}
		// Strip the version prefix so applyPatch() still receives the bare
		// flat op array the rest of the protocol documents.
		const ops = data.slice(1);
		if (!pageReady) {
			pendingPatches.push(ops);
			return;
		}
		applier.applyPatch(ops);
	};
	onPatchFromBackground(onPatch);

	/**
	 * Creates the real page and applier, then flushes any buffered patches.
	 * @returns {void}
	 */
	const onRenderPage = () => {
		const page = __CreatePage("0", 0);
		const pageId = __GetElementUniqueID(page);
		applier = createPatchApplier(pageId, {
			onEvent: (id, type, nativeEvent) => sendEventToBackground(id, type, nativeEvent),
		});
		applier.registerPageRoot(page);
		pageReady = true;
		for (const ops of pendingPatches) applier.applyPatch(ops);
		pendingPatches = [];
	};
	engine.addEventListener(renderPageEventName, onRenderPage);

	/**
	 * Removes the page lifecycle listeners.
	 * @returns {void}
	 */
	const onDestroyLifetime = () => {
		engine.removeEventListener(renderPageEventName, onRenderPage);
		engine.removeEventListener(destroyLifetimeEventName, onDestroyLifetime);
	};
	engine.addEventListener(destroyLifetimeEventName, onDestroyLifetime);
}
