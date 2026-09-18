import { describe, expect, it } from "@rstest/core";
import m from "mithril";
import { createPatchApplier } from "../src/apply-patch.js";
import { registerListRenderer } from "../src/list-support.js";
import { Op } from "../src/patch-protocol.js";

// Op.CreateList end-to-end: registerListRenderer() (the main-thread.ts side
// of the design — see docs/native-papi/papi-06-virtualized-lists.md in
// mithril-lynx-ui) plus a raw CreateList/SetListItems op sequence applied
// directly (mithril-lynx-ui's own List component is what normally produces
// these ops from the background thread; this test drives apply-patch.js
// directly, the same level end-to-end.test.ts already operates at).
//
// componentAtIndex/enqueueComponent are native's own synchronous contract —
// driven directly here, exactly like mithril-lynx-ui's own list.test.ts
// already does against mithril-lynx-v1's list.js.

function requestCell(listHandle: any, index: number, opId = 1) {
	const listId = __GetElementUniqueID(listHandle);
	return listHandle.componentAtIndex(listHandle, listId, index, opId);
}

function releaseCell(listHandle: any, sign: unknown) {
	const listId = __GetElementUniqueID(listHandle);
	listHandle.enqueueComponent(listHandle, listId, sign);
}

function textOf(node: any): string {
	if (node == null) return "";
	let out = "";
	for (let child = node.firstChild; child != null; child = child.nextSibling) {
		out += child.nodeType === 3 ? child.nodeValue : textOf(child);
	}
	return out;
}

function setupList(rendererKey: string) {
	lynxTestingEnv.switchToMainThread();
	const pageId = __GetElementUniqueID(__CreatePage());
	const applier = createPatchApplier(pageId);
	applier.registerPageRoot(__CreateView(pageId));
	applier.applyPatch([Op.CreateList, 1, rendererKey, "vertical", "single", 1]);
	const listHandle = applier.getHandle(1) as any;
	return { applier, listHandle };
}

function setItems(applier: ReturnType<typeof createPatchApplier>, items: unknown[]) {
	applier.applyPatch([Op.SetListItems, 1, JSON.stringify(items)]);
}

describe("Op.CreateList (native virtualized list support)", () => {
	it("throws a clear error for an unregistered renderer key", () => {
		lynxTestingEnv.switchToMainThread();
		const pageId = __GetElementUniqueID(__CreatePage());
		const applier = createPatchApplier(pageId);
		applier.registerPageRoot(__CreateView(pageId));

		expect(() => applier.applyPatch([Op.CreateList, 1, "nonexistent-key", "vertical", "single", 1])).toThrow(
			/no list renderer registered for "nonexistent-key"/,
		);
	});

	it("renders real content per cell via the registered renderer, driven by componentAtIndex", () => {
		registerListRenderer("basic", (item: string, index: number) => m("text", {}, `${index}:${item}`));

		const { applier, listHandle } = setupList("basic");
		setItems(applier, ["a", "b", "c"]);

		requestCell(listHandle, 0);
		requestCell(listHandle, 1);
		const cellWrapper = listHandle.children[1]; // second appended cell -> index 1
		expect(textOf(cellWrapper)).toBe("1:b");
	});

	it("recycles a cell for a different index, and its content updates to match", () => {
		registerListRenderer("recycle-basic", (item: string, index: number) => m("text", {}, `${index}:${item}`));

		const { applier, listHandle } = setupList("recycle-basic");
		setItems(applier, ["a", "b", "c", "d"]);

		const signA = requestCell(listHandle, 0);
		const wrapperA = listHandle.children[0];
		expect(textOf(wrapperA)).toBe("0:a");

		releaseCell(listHandle, signA);
		const signD = requestCell(listHandle, 3);

		// Recycled: the SAME sign/wrapper comes back, now showing the new index's content.
		expect(signD).toBe(signA);
		expect(textOf(wrapperA)).toBe("3:d");
	});

	it("SetListItems with a larger array requests the newly available indices without error", () => {
		registerListRenderer("grow", (item: string, index: number) => m("text", {}, `${index}:${item}`));

		const { applier, listHandle } = setupList("grow");

		setItems(applier, ["a", "b"]);
		expect(() => requestCell(listHandle, 1)).not.toThrow();
		expect(() => requestCell(listHandle, 2)).toThrow(/cellIndex 2 out of range/);

		setItems(applier, ["a", "b", "c"]);
		expect(() => requestCell(listHandle, 2)).not.toThrow();
	});
});
