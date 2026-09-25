import { afterEach, beforeEach, describe, expect, it, rstest } from "@rstest/core";
import m from "mithril-runtime";
import { renderApp } from "../src/background.js";
import { unregister } from "../src/mount-redraw.js";

// High-frequency events (gesturemove, touchmove, scroll) must reach the app's
// handler once per sample, but must NOT trigger one full render + patch per
// sample — the redraw they ask for is coalesced to at most one per frame.
// Everything else still renders synchronously.

type Router = (event: { data: { id: number; type: string; payload?: object } }) => void;

function mountCounter() {
	lynxTestingEnv.switchToBackgroundThread();
	unregister();
	const moves: number[] = [];
	let count = 0;
	let patches = 0;
	let router: Router | null = null;
	const app = renderApp({
		root: () =>
			m(
				"view",
				{
					ongesturemove: (e: any) => {
						moves.push(e.clientX);
						count++;
						if (e.skipRedraw) e.redraw = false;
					},
					ongestureup: () => {
						count++;
					},
					ontap: () => {
						count++;
					},
				},
				m("text", String(count)),
			),
		sendPatch: () => {
			patches++;
		},
		subscribeEvents: (handler: Router) => {
			router = handler;
		},
	});
	const id = (app.document.firstChild as any)._id as number;
	const send = (type: string, payload?: object) => router!({ data: { id, type, payload } });
	return { app, moves, send, patches: () => patches };
}

// Fake timers: the coalesced render uses a 16ms timer when
// lynx.requestAnimationFrame is absent (as in the testing environment), so
// advancing the clock makes "one frame later" deterministic.
const nextFrame = () => rstest.advanceTimersByTime(16);

describe("renders after high-frequency events are coalesced per frame", () => {
	beforeEach(() => {
		rstest.useFakeTimers();
	});
	afterEach(() => {
		rstest.useRealTimers();
	});

	it("five gesturemoves in one tick: every handler runs, one render follows", () => {
		const { moves, send, patches } = mountCounter();
		const before = patches();

		for (let x = 1; x <= 5; x++) send("gesturemove", { clientX: x });
		expect(moves).toEqual([1, 2, 3, 4, 5]);
		expect(patches()).toBe(before);

		nextFrame();
		expect(patches()).toBe(before + 1);
	});

	it("gestureup after moves renders immediately and cancels the pending frame render", () => {
		const { send, patches } = mountCounter();
		const before = patches();

		send("gesturemove", { clientX: 1 });
		send("gesturemove", { clientX: 2 });
		send("gestureup");
		expect(patches()).toBe(before + 1);

		nextFrame();
		expect(patches()).toBe(before + 1);
	});

	it("a tap still renders synchronously", () => {
		const { send, patches } = mountCounter();
		const before = patches();

		send("tap");
		expect(patches()).toBe(before + 1);
	});

	it("an explicit redraw() between moves and the frame makes the frame render a no-op", () => {
		const { app, send, patches } = mountCounter();
		const before = patches();

		send("gesturemove", { clientX: 1 });
		app.redraw();
		expect(patches()).toBe(before + 1);

		nextFrame();
		expect(patches()).toBe(before + 1);
	});

	it("a move whose handler sets e.redraw = false schedules no render at all", () => {
		const { send, patches } = mountCounter();
		const before = patches();

		send("gesturemove", { clientX: 1, skipRedraw: true });
		nextFrame();
		expect(patches()).toBe(before);
	});
});
