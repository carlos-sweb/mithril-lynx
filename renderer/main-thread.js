// renderer/main-thread.js
//
// "Renderer mode" (project plan, Phase 4) main-thread half: replays the
// op-log produced by renderer/background.js's virtual tree against a real
// LynxNodeWrapper tree, and forwards real Element PAPI events back to the
// background thread by vid (see renderer/background.js's header for the
// full picture).
//
// applyPatch() deliberately does NOT reimplement any PAPI-mapping logic —
// every op is replayed by calling the EXACT SAME method (setAttribute,
// className =, style.setProperty, ...) a normal main-thread-owned Mithril
// app would call on a real LynxNodeWrapper, so it inherits that (already
// tested) code's correctness for free. The one exception is style: see the
// setStyleProps case below for why it calls __SetInlineStyles directly.

import shim from "../src/lynx-mithril-shim.js";
import {
	destroyLifetimeEventName,
	renderPageEventName,
	rendererEventEventName,
	rendererPatchEventName,
} from "../internal/constants.js";

/**
 * Waits for __RenderPage to create the real page (matching data-channel
 * mode's timing, in case native requires it before the tree can be built),
 * then wires the patch/event channel. The background thread's own initial
 * renderApp() runs independently and may finish before or after
 * __RenderPage fires, so patches arriving early are buffered and replayed
 * in order once the page exists. Call once, at main-thread.ts's top level.
 */
export function setupRenderer() {
	// vid -> LynxNodeWrapper. Scoped to this setupRenderer() call (a real app
	// calls it exactly once) rather than module-level, so it can never hold
	// stale entries from a previous, unrelated render.
	const vidMap = new Map();
	// (vid + ":" + type) -> the forwarding function passed to addEventListener,
	// so a later removeEvent op can pass the SAME reference to
	// removeEventListener (LynxNodeWrapper matches listeners by identity).
	const forwarders = new Map();

	function applyOp(op) {
		switch (op.op) {
			case "createElement": {
				const wrapper = vidMap.get(0).ownerDocument.createElement(op.tag);
				vidMap.set(op.vid, wrapper);
				break;
			}
			case "createText": {
				const wrapper = vidMap.get(0).ownerDocument.createTextNode(op.value);
				vidMap.set(op.vid, wrapper);
				break;
			}
			case "appendChild":
				vidMap.get(op.parentVid).appendChild(vidMap.get(op.childVid));
				break;
			case "insertBefore":
				vidMap.get(op.parentVid).insertBefore(
					vidMap.get(op.childVid),
					op.refVid != null ? vidMap.get(op.refVid) : null,
				);
				break;
			case "removeChild":
				vidMap.get(op.parentVid).removeChild(vidMap.get(op.childVid));
				vidMap.delete(op.childVid);
				break;
			case "setProp":
				vidMap.get(op.vid)[op.key] = op.value;
				break;
			case "setAttribute":
				vidMap.get(op.vid).setAttribute(op.key, op.value);
				break;
			case "removeAttribute":
				vidMap.get(op.vid).removeAttribute(op.key);
				break;
			case "setStyleProps": {
				// The virtual side's styles object is already the COMPLETE, current
				// style set (VirtualStyleProxy._flush recomputes it from scratch
				// every time, exactly like the real LynxStyleProxy._flush does).
				// Calling __SetInlineStyles directly with that complete object —
				// rather than replaying individual `wrapper.style[key] = value`
				// assignments through the real LynxStyleProxy — is what correctly
				// propagates REMOVALS: the real proxy only accumulates/overwrites via
				// setProperty, so a key absent from this op (because it was removed
				// on the virtual side) would otherwise never get cleared.
				//
				// Every node gets a style proxy flushed unconditionally (matching
				// the real shim's own flushTree(), which does the same for EVERY
				// LynxStyleProxy ever created) — including raw text nodes, which
				// don't support inline styles at all. The real shim's flushTree()
				// silently swallows that failure (`try { ... } catch {}`) since it
				// runs the flush and the PAPI call in one step, same-thread; here
				// the two are split across the wire, so the try/catch has to live
				// here, on the replay side, instead.
				try {
					__SetInlineStyles(vidMap.get(op.vid)._handle, op.styles);
				} catch (e) {
					/* ignore, e.g. raw text nodes have no .style */
				}
				break;
			}
			case "setText":
				vidMap.get(op.vid).nodeValue = op.value;
				break;
			case "addEvent": {
				const wrapper = vidMap.get(op.vid);
				const forward = (ev) => {
					const { currentTarget, preventDefault, stopPropagation, ...payload } = ev;
					lynx.getJSContext().dispatchEvent({
						type: rendererEventEventName,
						data: { vid: op.vid, type: ev.type, payload },
					});
				};
				forwarders.set(op.vid + ":" + op.type, forward);
				wrapper.addEventListener(op.type, forward, {});
				break;
			}
			case "removeEvent": {
				const key = op.vid + ":" + op.type;
				const forward = forwarders.get(key);
				if (forward != null) {
					vidMap.get(op.vid).removeEventListener(op.type, forward, {});
					forwarders.delete(key);
				}
				break;
			}
			default:
				throw new Error(`renderer/main-thread.js: unknown op "${op.op}"`);
		}
	}

	function applyPatch(ops) {
		for (const op of ops) applyOp(op);
		__FlushElementTree();
	}

	const engine = lynx.getEngine();
	const background = lynx.getJSContext();
	let pageReady = false;
	let pendingPatches = [];

	const onPatch = (event) => {
		if (!pageReady) {
			pendingPatches.push(event.data);
			return;
		}
		applyPatch(event.data);
	};
	background.addEventListener(rendererPatchEventName, onPatch);

	const onRenderPage = () => {
		const page = __CreatePage("0", 0);
		vidMap.set(0, shim.createPageWrapper(page));
		pageReady = true;
		for (const ops of pendingPatches) applyPatch(ops);
		pendingPatches = [];
	};
	engine.addEventListener(renderPageEventName, onRenderPage);

	const onDestroyLifetime = () => {
		background.dispatchEvent({ type: destroyLifetimeEventName, data: undefined });
		background.removeEventListener(rendererPatchEventName, onPatch);
		engine.removeEventListener(renderPageEventName, onRenderPage);
		engine.removeEventListener(destroyLifetimeEventName, onDestroyLifetime);
	};
	engine.addEventListener(destroyLifetimeEventName, onDestroyLifetime);
}
