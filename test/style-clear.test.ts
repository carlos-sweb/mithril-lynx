import { describe, expect, it } from "@rstest/core";
import m from "mithril-runtime";
import { createPatchApplier } from "../src/apply-patch.js";
import { renderApp } from "../src/background.js";
import { unregister } from "../src/mount-redraw.js";
import { forEachOp, Op } from "../src/patch-protocol.js";

// Mithril clears a whole style with `element.style = ""` (a style prop that
// disappears, or unconditionally before a first object style). There is no
// device-validated bulk-clear PAPI, so fake-dom.js must expand the clear into
// one RemoveStyleProperty per property actually applied — and emit nothing
// when there is nothing to clear.

function mount(styleOf: () => Record<string, string> | undefined) {
	lynxTestingEnv.switchToMainThread();
	const pageId = __GetElementUniqueID(__CreatePage());
	const applier = createPatchApplier(pageId);
	applier.registerPageRoot(__CreateView(pageId));

	lynxTestingEnv.switchToBackgroundThread();
	unregister();
	const patches: unknown[][] = [];
	const app = renderApp({
		root: () => {
			const style = styleOf();
			return m("view", style ? { style } : {});
		},
		sendPatch: (ops) => patches.push(ops),
		subscribeEvents: () => {},
	});

	/** Applies every patch produced since the last call on the main thread
	 * (which must not throw) and returns the style ops they carried. */
	let applied = 0;
	const flushToMainThread = () => {
		const fresh = patches.slice(applied);
		applied = patches.length;
		lynxTestingEnv.switchToMainThread();
		for (const ops of fresh) applier.applyPatch(ops);
		lynxTestingEnv.switchToBackgroundThread();
		const removed: string[] = [];
		const set: string[] = [];
		for (const ops of fresh) {
			forEachOp(ops, (opcode, args) => {
				if (opcode === Op.RemoveStyleProperty) removed.push(args[1] as string);
				if (opcode === Op.SetStyleProperty) set.push(args[1] as string);
			});
		}
		return { removed, set };
	};
	return { app, flushToMainThread };
}

describe("clearing a whole style expands into per-property removals", () => {
	it("removing the style prop of a styled element no longer throws", () => {
		let style: Record<string, string> | undefined = { color: "red" };
		const { app, flushToMainThread } = mount(() => style);
		flushToMainThread();

		style = undefined;
		app.redraw();
		expect(flushToMainThread().removed).toEqual(["color"]);
	});

	it("clearing {color, width} removes both properties", () => {
		let style: Record<string, string> | undefined = { color: "red", width: "10px" };
		const { app, flushToMainThread } = mount(() => style);
		flushToMainThread();

		style = undefined;
		app.redraw();
		expect(flushToMainThread().removed.sort()).toEqual(["color", "width"]);
	});

	it("clearing a style whose properties were already removed one by one emits nothing", () => {
		let style: Record<string, string> | undefined = { color: "red", width: "10px" };
		const { app, flushToMainThread } = mount(() => style);
		flushToMainThread();

		// Object -> object: Mithril removes the missing keys individually.
		style = {};
		app.redraw();
		expect(flushToMainThread().removed.sort()).toEqual(["color", "width"]);

		// Now the whole style goes away: `style = ""` with nothing left to clear.
		style = undefined;
		app.redraw();
		expect(flushToMainThread().removed).toEqual([]);
	});

	it("an element that never had a style gets no clear op on its first styled render", () => {
		const { flushToMainThread } = mount(() => ({ color: "red" }));
		const { removed, set } = flushToMainThread();
		expect(removed).toEqual([]);
		expect(set).toEqual(["color"]);
	});
});
