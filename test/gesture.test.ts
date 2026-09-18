import { describe, expect, it } from "@rstest/core";
import m from "mithril";
import { renderApp } from "../src/background.js";
import { createPatchApplier } from "../src/apply-patch.js";

// Op.SetGestureDetector end-to-end: a component calls vnode.dom's own
// setGestureDetector() (fake-dom.js) in oncreate, the resulting op gets
// replayed onto a REAL simulated __SetGestureDetector call (via
// @lynx-js/testing-environment, not a mock), and the arena-claim policy
// (apply-patch.js's own createArenaTracker) is exercised by extracting the
// registered worklet callbacks and invoking them the same way native would
// — see mithril-lynx-ui's docs/native-papi/papi-05-native-gestures.md for
// the full design writeup this implements.

function gestureCallbacksOf(handle: any): Record<string, (event: unknown, controller: unknown) => void> {
	const entries = handle.gesture.config.callbacks as { name: string; callback: unknown }[];
	const out: Record<string, (event: unknown, controller: unknown) => void> = {};
	for (const entry of entries) {
		out[entry.name] = (event, controller) => (globalThis as any).runWorklet(entry.callback, [event, controller]);
	}
	return out;
}

function touchEvent(clientX: number, clientY: number) {
	return { params: { clientX, clientY } };
}

function makeController() {
	const calls: { fn: string; args: unknown[] }[] = [];
	return {
		calls,
		__SetGestureState(...args: unknown[]) {
			calls.push({ fn: "__SetGestureState", args });
		},
		__ConsumeGesture(...args: unknown[]) {
			calls.push({ fn: "__ConsumeGesture", args });
		},
	};
}

function mountWithGesture(arenaPolicy: unknown) {
	lynxTestingEnv.switchToMainThread();
	const pageId = __GetElementUniqueID(__CreatePage());
	const receivedEvents: { type: string; clientX: number; clientY: number }[] = [];
	const applier = createPatchApplier(pageId, {
		onEvent: (id, type, payload: any) => {
			receivedEvents.push({ type, clientX: payload.clientX, clientY: payload.clientY });
		},
	});
	applier.registerPageRoot(__CreateView(pageId));

	lynxTestingEnv.switchToBackgroundThread();
	let lastOps: unknown[] | null = null;
	const app = renderApp({
		root: () => m("view", { class: "target", oncreate: (vnode: any) => vnode.dom.setGestureDetector("native", arenaPolicy) }),
		sendPatch: (ops) => {
			lastOps = ops;
		},
	});

	lynxTestingEnv.switchToMainThread();
	applier.applyPatch(lastOps as unknown[]);

	const handle = applier.getHandle(1);
	return { handle, callbacks: gestureCallbacksOf(handle), receivedEvents };
}

describe("Op.SetGestureDetector (native gesture support)", () => {
	it("registers a real __SetGestureDetector call with the given type", () => {
		const { handle } = mountWithGesture({ mode: "claim" });
		expect(handle.gesture.type).toBe(7); // GESTURE_TYPE_CODES.native
	});

	it('"claim" policy claims on touches-down and never reconsiders', () => {
		const { callbacks } = mountWithGesture({ mode: "claim" });
		const controller = makeController();

		callbacks.onTouchesDown(touchEvent(0, 0), controller);
		callbacks.onTouchesMove(touchEvent(50, 0), controller);
		callbacks.onTouchesMove(touchEvent(0, 50), controller); // even a vertical move — no reconsideration

		expect(controller.calls).toEqual([{ fn: "__ConsumeGesture", args: [expect.anything(), expect.any(Number), { consume: true, inner: false }] }]);
	});

	it('"axis-lock" (referenceMoves: 0) decides on the first move, using touches-down as the reference', () => {
		const { callbacks } = mountWithGesture({ mode: "axis-lock", axis: "horizontal", referenceMoves: 0 });
		const controller = makeController();

		callbacks.onTouchesDown(touchEvent(0, 0), controller);
		callbacks.onTouchesMove(touchEvent(40, 5), controller); // mostly horizontal

		expect(controller.calls.map((c) => c.fn)).toEqual(["__ConsumeGesture", "__ConsumeGesture"]);
		expect(controller.calls[1].args[2]).toEqual({ consume: true, inner: false });
	});

	it('"axis-lock" releases and fails the gesture when the losing axis wins', () => {
		const { callbacks } = mountWithGesture({ mode: "axis-lock", axis: "horizontal", referenceMoves: 0 });
		const controller = makeController();

		callbacks.onTouchesDown(touchEvent(0, 0), controller);
		callbacks.onTouchesMove(touchEvent(5, 40), controller); // mostly vertical

		// Claim eagerly on down, release once the axis loses, THEN fail —
		// releasing the claim before failing matters: an ancestor (e.g. a
		// <scroll-view>) must see the arena freed, not just "this gesture gave up".
		expect(controller.calls.map((c) => c.fn)).toEqual(["__ConsumeGesture", "__ConsumeGesture", "__SetGestureState"]);
		expect(controller.calls[1].args[2]).toEqual({ consume: false, inner: false });
		expect(controller.calls[2].args[2]).toBe(2); // GestureState.fail (args: [handle, gestureId, state])
	});

	it('"axis-lock" (referenceMoves: 1) uses the first move as reference and decides on the second', () => {
		const { callbacks } = mountWithGesture({ mode: "axis-lock", axis: "horizontal", referenceMoves: 1 });
		const controller = makeController();

		callbacks.onTouchesDown(touchEvent(0, 0), controller);
		callbacks.onTouchesMove(touchEvent(10, 10), controller); // just records the reference — no decision yet
		expect(controller.calls.map((c) => c.fn)).toEqual(["__ConsumeGesture"]);

		callbacks.onTouchesMove(touchEvent(60, 15), controller); // horizontal relative to the FIRST move
		expect(controller.calls.map((c) => c.fn)).toEqual(["__ConsumeGesture", "__ConsumeGesture"]);
	});

	it("forwards touches-down/move/up to the background thread as gesturedown/gesturemove/gestureup events", () => {
		const { callbacks, receivedEvents } = mountWithGesture({ mode: "claim" });
		const controller = makeController();

		callbacks.onTouchesDown(touchEvent(1, 2), controller);
		callbacks.onTouchesMove(touchEvent(3, 4), controller);
		callbacks.onTouchesUp(touchEvent(5, 6), controller);

		expect(receivedEvents).toEqual([
			{ type: "gesturedown", clientX: 1, clientY: 2 },
			{ type: "gesturemove", clientX: 3, clientY: 4 },
			{ type: "gestureup", clientX: 5, clientY: 6 },
		]);
	});

	it("a forwarded gesture event reaches the background-thread fake-dom node like any other event", () => {
		lynxTestingEnv.switchToMainThread();
		const pageId = __GetElementUniqueID(__CreatePage());
		let forward: ((id: number, type: string, payload: unknown) => void) | null = null;
		const applier = createPatchApplier(pageId, {
			onEvent: (id, type, payload) => forward?.(id, type, payload),
		});
		applier.registerPageRoot(__CreateView(pageId));

		lynxTestingEnv.switchToBackgroundThread();
		const moves: number[] = [];
		let lastOps: unknown[] | null = null;
		const app = renderApp({
			root: () =>
				m("view", {
					class: "target",
					oncreate: (vnode: any) => vnode.dom.setGestureDetector("native", { mode: "claim" }),
					ongesturemove: (e: any) => moves.push(e.clientX),
				}),
			sendPatch: (ops) => {
				lastOps = ops;
			},
		});
		forward = (id, type, payload: any) => {
			const node = app.document.getNodeById(id);
			node?.dispatchEvent({ type, currentTarget: node, ...payload });
		};

		lynxTestingEnv.switchToMainThread();
		applier.applyPatch(lastOps as unknown[]);
		const handle = applier.getHandle(1);
		const callback = gestureCallbacksOf(handle).onTouchesMove;
		const controller = makeController();
		callback(touchEvent(42, 0), controller);

		expect(moves).toEqual([42]);
	});
});
