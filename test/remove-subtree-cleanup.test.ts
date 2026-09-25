import { describe, expect, it } from "@rstest/core";
import { createPatchApplier } from "../src/apply-patch.js";
import { createVirtualBackend } from "../src/backends/virtual-backend.js";
import { createLynxDocument } from "../src/fake-dom.js";
import { Op } from "../src/patch-protocol.js";

// Mithril's removeDOM only ever calls removeChild on the ROOT of a removed
// subtree, so both threads must release every descendant's bookkeeping
// themselves — otherwise a long-running app leaks every element (and its
// listeners) it ever removed.
describe("removing a subtree releases every descendant", () => {
	it("main thread: RemoveChild drops the handles of the whole subtree", () => {
		lynxTestingEnv.switchToMainThread();
		const pageId = __GetElementUniqueID(__CreatePage());
		const applier = createPatchApplier(pageId);
		applier.registerPageRoot(__CreateView(pageId));

		applier.applyPatch([
			Op.CreateElement, "view", 1,
			Op.CreateElement, "view", 2,
			Op.CreateElement, "view", 3,
			Op.InsertBefore, 0, 1, -1,
			Op.InsertBefore, 1, 2, -1,
			Op.InsertBefore, 2, 3, -1,
			Op.AddEvent, 2, "tap",
			Op.AddEvent, 3, "tap",
		]);
		expect(applier.getHandle(3)).toBeDefined();

		applier.applyPatch([Op.RemoveChild, 0, 1]);
		expect(applier.getHandle(1)).toBeUndefined();
		expect(applier.getHandle(2)).toBeUndefined();
		expect(applier.getHandle(3)).toBeUndefined();
		expect(applier.getHandle(0)).toBeDefined();
	});

	it("main thread: a node moved out of the subtree before removal survives", () => {
		lynxTestingEnv.switchToMainThread();
		const pageId = __GetElementUniqueID(__CreatePage());
		const applier = createPatchApplier(pageId);
		applier.registerPageRoot(__CreateView(pageId));

		applier.applyPatch([
			Op.CreateElement, "view", 1,
			Op.CreateElement, "view", 2,
			Op.CreateElement, "view", 4,
			Op.InsertBefore, 0, 1, -1,
			Op.InsertBefore, 0, 4, -1,
			Op.InsertBefore, 1, 2, -1,
			// Move 2 from under 1 to under 4.
			Op.InsertBefore, 4, 2, -1,
		]);

		applier.applyPatch([Op.RemoveChild, 0, 1]);
		expect(applier.getHandle(1)).toBeUndefined();
		expect(applier.getHandle(2)).toBeDefined();
		expect(applier.getHandle(4)).toBeDefined();
	});

	it("background thread: removeChild drops the whole subtree from the id map", () => {
		const document = createLynxDocument(createVirtualBackend());
		const a = document.createElement("view");
		const b = document.createElement("view");
		const c = document.createElement("text");
		document.appendChild(a);
		a.appendChild(b);
		b.appendChild(c);
		expect(document.getNodeById(c._id)).toBe(c);

		document.removeChild(a);
		expect(document.getNodeById(a._id)).toBeNull();
		expect(document.getNodeById(b._id)).toBeNull();
		expect(document.getNodeById(c._id)).toBeNull();
	});
});
