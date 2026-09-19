import { describe, expect, it } from "@rstest/core";
import m from "mithril";
import renderFactory from "mithril-runtime/render/render.js";
import { createPatchApplier } from "../src/apply-patch.js";
import { createVirtualBackend } from "../src/backends/virtual-backend.js";
import { createLynxDocument } from "../src/fake-dom.js";
import { renderListCell } from "../src/list-cell.js";
import { Op } from "../src/patch-protocol.js";

// Op.CreateList end-to-end. A cell's own content is computed on the
// BACKGROUND thread (list-cell.js's renderListCell(), through the app's own
// document/render — no separate render pipeline) and only replayed on the
// main thread (list-support.js) — see
// docs/native-papi/papi-06-virtualized-lists.md in mithril-lynx-ui. This
// test drives both halves directly: a background document renders each item
// into cells, then a main-thread applier replays Op.CreateList/
// Op.SetListItems with those cells, exactly like mithril-lynx-ui's own List
// component does end to end.

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

/** Stands in for mithril-lynx-ui's <List>: one persistent background
 * document + render instance, reused across calls — see list-cell.js's own
 * header for why callers keep one of these per list, not one per cell. */
function makeCellSource(renderItem: (item: any, index: number) => unknown) {
	const document = createLynxDocument(createVirtualBackend());
	const render = renderFactory();
	return {
		document,
		buildCells: (items: unknown[]) => items.map((item, index) => renderListCell(document, render, () => {}, renderItem, item, index)),
	};
}

function setupList() {
	lynxTestingEnv.switchToMainThread();
	const pageId = __GetElementUniqueID(__CreatePage());
	const applier = createPatchApplier(pageId);
	applier.registerPageRoot(__CreateView(pageId));
	applier.applyPatch([Op.CreateList, 1, "vertical", "single", 1]);
	const listHandle = applier.getHandle(1) as any;
	return { applier, listHandle };
}

function setCells(applier: ReturnType<typeof createPatchApplier>, cells: unknown[]) {
	applier.applyPatch([Op.SetListItems, 1, JSON.stringify(cells)]);
}

describe("Op.CreateList (native virtualized list support)", () => {
	it("renders real content per cell from ops the background thread already computed", () => {
		const { buildCells } = makeCellSource((item: string, index: number) => m("text", {}, `${index}:${item}`));
		const { applier, listHandle } = setupList();
		setCells(applier, buildCells(["a", "b", "c"]));

		requestCell(listHandle, 0);
		requestCell(listHandle, 1);
		const cellWrapper = listHandle.children[1]; // second appended cell -> index 1
		expect(textOf(cellWrapper)).toBe("1:b");
	});

	it("recycles a cell for a different index, and its content updates to match", () => {
		const { buildCells } = makeCellSource((item: string, index: number) => m("text", {}, `${index}:${item}`));
		const { applier, listHandle } = setupList();
		setCells(applier, buildCells(["a", "b", "c", "d"]));

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
		const { buildCells } = makeCellSource((item: string, index: number) => m("text", {}, `${index}:${item}`));
		const { applier, listHandle } = setupList();

		setCells(applier, buildCells(["a", "b"]));
		expect(() => requestCell(listHandle, 1)).not.toThrow();
		expect(() => requestCell(listHandle, 2)).toThrow(/cellIndex 2 out of range/);

		setCells(applier, buildCells(["a", "b", "c"]));
		expect(() => requestCell(listHandle, 2)).not.toThrow();
	});

	it("SetListItems re-flushes an already-attached cell's content in place", () => {
		const { buildCells } = makeCellSource((item: string, index: number) => m("text", {}, `${index}:${item}`));
		const { applier, listHandle } = setupList();
		setCells(applier, buildCells(["a", "b"]));

		requestCell(listHandle, 0);
		const wrapper = listHandle.children[0];
		expect(textOf(wrapper)).toBe("0:a");

		setCells(applier, buildCells(["z", "b"])); // same count, index 0's content changed
		expect(textOf(wrapper)).toBe("0:z");
	});

	it("a recycled cell is repositioned in the real tree to match its new index, not left where it was created", () => {
		const { buildCells } = makeCellSource((item: string, index: number) => m("text", {}, `${index}:${item}`));
		const { applier, listHandle } = setupList();
		setCells(applier, buildCells(["a", "b", "c", "d"]));

		requestCell(listHandle, 0);
		const signB = requestCell(listHandle, 1);
		requestCell(listHandle, 2);
		// Real tree order matches request order so far: a, b, c.
		expect([listHandle.children[0], listHandle.children[1], listHandle.children[2]].map(textOf)).toEqual(["0:a", "1:b", "2:c"]);

		releaseCell(listHandle, signB); // b's wrapper goes to the recycle pool, still sitting in the middle of the tree
		requestCell(listHandle, 3); // recycled for "d" — index 3 is after every other attached cell, so it belongs at the END

		const children = [listHandle.children[0], listHandle.children[1], listHandle.children[2]];
		expect(children.map(textOf)).toEqual(["0:a", "2:c", "3:d"]); // not ["0:a", "3:d", "2:c"] — the bug this test guards against
	});

	it("a tap inside a cell dispatches through the background thread's own fake-dom node", () => {
		const { document, buildCells } = makeCellSource(() =>
			m("text", { ontap: () => { taps += 1; } }, "tap me"),
		);
		let taps = 0;
		const { applier, listHandle } = setupList();
		const cells = buildCells([{}]);
		setCells(applier, cells);
		requestCell(listHandle, 0);

		const node = document.getNodeById((cells[0] as any).rootChildIds[0]);
		node!.dispatchEvent({ type: "tap", currentTarget: node, preventDefault() {}, stopPropagation() {} });
		expect(taps).toBe(1);
	});
});
