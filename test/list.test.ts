import { afterEach, describe, expect, it } from "@rstest/core";
import m from "mithril-runtime";
import { createPatchApplier } from "../src/apply-patch.js";
import { renderApp } from "../src/background.js";
import { LIST_ATTRIBUTES } from "../src/list-attributes.js";
import { unregister } from "../src/mount-redraw.js";
import { forEachOp, Op } from "../src/patch-protocol.js";

// `<list>` / `<list-item>` as ordinary Mithril elements, end to end: the
// background thread renders and diffs them like any other element, the main
// thread (list-runtime.js) turns list-child ops into `update-list-info` and
// attaches items only when native asks (componentAtIndex). The testing
// environment records every `update-list-info` value as a JSON array on the
// list element, and keeps the callbacks passed to __CreateList /
// __UpdateListCallbacks on the element itself.

type Info = { insertAction: any[]; removeAction: number[]; updateAction: any[] };

const realCreateList = () => (globalThis as any).__CreateList;
let restoreCreateList: (() => void) | null = null;

afterEach(() => {
	restoreCreateList?.();
	restoreCreateList = null;
});

/** Mounts `view` through the real renderApp + a main-thread applier. */
function mount(view: () => unknown) {
	// Capture the 5th __CreateList argument (componentAtIndexes), which the
	// testing environment does not keep on the element. Re-installed after
	// every switch to the main thread, which re-injects its globals.
	const batchCallbacks: Function[] = [];
	let original: any = null;
	const toMainThread = () => {
		lynxTestingEnv.switchToMainThread();
		const current = realCreateList();
		if (current.__captures) return;
		original = current;
		const wrapper: any = (...args: any[]) => {
			batchCallbacks.push(args[4]);
			return current(...args);
		};
		wrapper.__captures = true;
		(globalThis as any).__CreateList = wrapper;
	};
	restoreCreateList = () => {
		lynxTestingEnv.switchToMainThread();
		if (original != null) (globalThis as any).__CreateList = original;
	};
	toMainThread();
	const pageId = __GetElementUniqueID(__CreatePage());
	let router: ((event: any) => void) | null = null;
	const applier = createPatchApplier(pageId, {
		onEvent: (id, type, payload) => {
			lynxTestingEnv.switchToBackgroundThread();
			router?.({ data: { id, type, payload } });
			lynxTestingEnv.switchToMainThread();
		},
	});
	applier.registerPageRoot(__CreateView(pageId));

	lynxTestingEnv.switchToBackgroundThread();
	unregister();
	const patches: unknown[][] = [];
	const app = renderApp({
		root: view,
		sendPatch: (ops) => patches.push(ops),
		subscribeEvents: (handler) => {
			router = handler;
		},
	});

	let applied = 0;
	/** Applies pending patches on the main thread and returns their ops. */
	const flush = () => {
		const fresh = patches.slice(applied);
		applied = patches.length;
		toMainThread();
		for (const ops of fresh) applier.applyPatch(ops);
		return fresh;
	};
	const redraw = () => {
		lynxTestingEnv.switchToBackgroundThread();
		app.redraw();
		return flush();
	};
	flush();
	const listNode = () => findByTag(app.document, "list");
	const listHandle = () => applier.getHandle(listNode()._id) as any;
	const listID = () => __GetElementUniqueID(listHandle());
	return {
		app,
		applier,
		redraw,
		flush,
		listNode,
		listHandle,
		/** Every update-list-info the list received, in order. */
		infos: (): Info[] => JSON.parse(listHandle().getAttribute("update-list-info") ?? "[]"),
		lastInfo: (): Info => {
			const all = JSON.parse(listHandle().getAttribute("update-list-info") ?? "[]");
			return all[all.length - 1];
		},
		requestCell: (index: number) => listHandle().componentAtIndex(listHandle(), listID(), index, 1, false),
		requestCells: (indexes: number[]) =>
			batchCallbacks[batchCallbacks.length - 1](listHandle(), listID(), indexes, indexes.map((_, i) => i + 1), false, false),
		releaseCell: (sign: number) => listHandle().enqueueComponent(listHandle(), listID(), sign),
		/** item-key of each list-item currently attached natively, in tree order. */
		attachedKeys: () => Array.from(listHandle().children as any[]).map((child: any) => child.getAttribute("item-key")),
		itemHandle: (key: string) => applier.getHandle(findItem(app.document, key)._id) as any,
	};
}

function findByTag(node: any, tag: string): any {
	if (node.tag === tag) return node;
	for (const child of node._children ?? []) {
		const found = findByTag(child, tag);
		if (found) return found;
	}
	return null;
}

function findItem(node: any, key: string): any {
	if (node.tag === "list-item" && node._typedValues?.["item-key"] === key) return node;
	for (const child of node._children ?? []) {
		const found = findItem(child, key);
		if (found) return found;
	}
	return null;
}

function listView(keys: () => string[], itemAttrs: (key: string) => object = () => ({}), listAttrs: () => object = () => ({})) {
	return () =>
		m(
			"list",
			Object.assign({ "list-type": "single", "span-count": 1, "scroll-orientation": "vertical" }, listAttrs()),
			keys().map((key) => m("list-item", Object.assign({ key, "item-key": key }, itemAttrs(key)), m("text", key))),
		);
}

/** Replays one update-list-info onto a key array the way native does. */
function applyInfo(keys: string[], info: Info): string[] {
	const out = keys.slice();
	for (const index of info.removeAction.slice().sort((a, b) => b - a)) out.splice(index, 1);
	for (const action of info.insertAction.slice().sort((a, b) => a.position - b.position)) out.splice(action.position, 0, action["item-key"]);
	return out;
}

function setAttributeOps(patches: unknown[][]) {
	const out: Record<string, unknown> = {};
	for (const ops of patches) {
		forEachOp(ops, (opcode, args) => {
			if (opcode === Op.SetAttribute) out[args[1] as string] = args[2];
		});
	}
	return out;
}

describe("<list> attributes", () => {
	it("every documented <list> attribute reaches native with its raw type", () => {
		const values: Record<string, unknown> = {
			"list-type": "flow",
			"span-count": 2,
			"scroll-orientation": "horizontal",
			"enable-scroll": false,
			"enable-nested-scroll": false,
			sticky: true,
			"sticky-offset": 50,
			bounces: false,
			"initial-scroll-index": 3,
			"need-visible-item-info": true,
			"upper-threshold-item-count": 2,
			"lower-threshold-item-count": 4,
			"scroll-event-throttle": 100,
			"item-snap": { factor: 0.5, offset: -20 },
			"update-animation": "default",
			"need-layout-complete-info": true,
			"layout-id": 7,
			"preload-buffer-count": 5,
			"scroll-bar-enable": false,
			"harmony-scroll-edge-effect": false,
			"experimental-recycle-sticky-item": false,
		};
		expect(Object.keys(values).sort()).toEqual([...LIST_ATTRIBUTES].sort());

		const { listHandle } = mount(() => m("list", values));
		for (const [name, value] of Object.entries(values)) {
			const stored = listHandle().getAttribute(name);
			expect([name, stored]).toEqual([name, typeof value === "string" ? value : JSON.stringify(value)]);
		}
	});

	it("false is sent as false (not dropped), and clearing a prop removes it", () => {
		let attrs: Record<string, unknown> = { bounces: false };
		const { listHandle, redraw } = mount(() => m("list", attrs));
		expect(listHandle().getAttribute("bounces")).toBe("false");

		attrs = {};
		redraw();
		expect(listHandle().getAttribute("bounces")).toBeNull();
	});

	it("an unchanged object attribute is not re-sent on redraw", () => {
		const { redraw } = mount(() => m("list", { "item-snap": { factor: 0, offset: 0 } }));
		expect(setAttributeOps(redraw())).toEqual({});
	});
});

describe("<list-item> platform info and update-list-info", () => {
	it("the initial render inserts every item with its platform info", () => {
		const { lastInfo, itemHandle } = mount(
			listView(
				() => ["a", "b", "c"],
				(key) => (key === "b" ? { "full-span": true, "sticky-top": true, "estimated-main-axis-size-px": 80, "reuse-identifier": "header", recyclable: false } : {}),
			),
		);
		expect(lastInfo()).toEqual({
			insertAction: [
				{ position: 0, type: "list-item", "item-key": "a" },
				{ position: 1, type: "header", "item-key": "b", "full-span": true, "sticky-top": true, "estimated-main-axis-size-px": 80, "reuse-identifier": "header", recyclable: false },
				{ position: 2, type: "list-item", "item-key": "c" },
			],
			removeAction: [],
			updateAction: [],
		});
		// Real attributes on the element too — except the list-only virtual ones.
		expect(itemHandle("b").getAttribute("full-span")).toBe("true");
		expect(itemHandle("b").getAttribute("reuse-identifier")).toBeNull();
		expect(itemHandle("b").getAttribute("recyclable")).toBeNull();
	});

	it("covers every documented <list-item> attribute", () => {
		const all = {
			"full-span": true,
			"sticky-top": true,
			"sticky-bottom": false,
			"estimated-height": 40,
			"estimated-height-px": 41,
			"estimated-main-axis-size-px": 42,
			"reuse-identifier": "r",
			recyclable: false,
		};
		const { lastInfo } = mount(listView(() => ["a"], () => all));
		expect(lastInfo().insertAction[0]).toEqual(Object.assign({ position: 0, type: "r", "item-key": "a" }, all));
	});

	it("a keyed insert and remove in the middle produce exactly that", () => {
		let keys = ["a", "b", "c"];
		const { redraw, lastInfo } = mount(listView(() => keys));
		keys = ["a", "x", "c"];
		redraw();
		expect(lastInfo()).toEqual({
			insertAction: [{ position: 1, type: "list-item", "item-key": "x" }],
			removeAction: [1],
			updateAction: [],
		});
	});

	it("reorders, inserts and removes replay natively into the new key order", () => {
		let keys = ["a", "b", "c", "d", "e"];
		const { redraw, lastInfo } = mount(listView(() => keys));
		const scenarios = [
			["e", "a", "b", "c", "d"],
			["b", "e", "a", "d"],
			["z", "d", "a", "y", "b", "e"],
			[],
			["q", "r"],
		];
		for (const next of scenarios) {
			const before = keys;
			keys = next;
			redraw();
			expect(applyInfo(before, lastInfo())).toEqual(next);
		}
	});

	it("a platform-info change on an existing item is an updateAction", () => {
		let wide = false;
		const { redraw, lastInfo, infos } = mount(listView(() => ["a", "b"], (key) => (key === "b" && wide ? { "full-span": true } : {})));
		const count = infos().length;
		wide = true;
		redraw();
		expect(infos().length).toBe(count + 1);
		expect(lastInfo()).toEqual({
			insertAction: [],
			removeAction: [],
			updateAction: [{ "item-key": "b", "full-span": true, from: 1, to: 1, type: "list-item", flush: false }],
		});
	});

	it("a redraw that changes nothing about the items sends no update-list-info", () => {
		const { redraw, infos } = mount(listView(() => ["a", "b"]));
		const count = infos().length;
		redraw();
		expect(infos().length).toBe(count);
	});
});

describe("native callbacks", () => {
	it("componentAtIndex attaches items in list order and returns their sign", () => {
		const { requestCell, attachedKeys, itemHandle } = mount(listView(() => ["a", "b", "c"]));
		expect(attachedKeys()).toEqual([]);
		const sign = requestCell(2);
		expect(sign).toBe(__GetElementUniqueID(itemHandle("c")));
		requestCell(0);
		expect(attachedKeys()).toEqual(["a", "c"]);
	});

	it("enqueueComponent detaches an item and it can be attached again", () => {
		const { requestCell, releaseCell, attachedKeys } = mount(listView(() => ["a", "b"]));
		const sign = requestCell(0);
		requestCell(1);
		releaseCell(sign);
		expect(attachedKeys()).toEqual(["b"]);
		requestCell(0);
		expect(attachedKeys()).toEqual(["a", "b"]);
	});

	it("componentAtIndexes attaches a batch", () => {
		const { requestCells, attachedKeys } = mount(listView(() => ["a", "b", "c"]));
		requestCells([1, 0]);
		expect(attachedKeys()).toEqual(["a", "b"]);
	});

	it("attached items that move are re-placed on the next callback", () => {
		let keys = ["a", "b", "c"];
		const { redraw, requestCell, attachedKeys } = mount(listView(() => keys));
		requestCell(0);
		requestCell(1);
		requestCell(2);
		keys = ["c", "a", "b"];
		redraw();
		requestCell(0);
		expect(attachedKeys()).toEqual(["c", "a", "b"]);
	});

	it("content updates reach an attached item", () => {
		let label = "one";
		const { redraw, requestCell, itemHandle } = mount(() =>
			m("list", { "list-type": "single", "span-count": 1 }, [m("list-item", { key: "a", "item-key": "a" }, m("text", label))]),
		);
		requestCell(0);
		label = "two";
		redraw();
		expect(itemHandle("a").textContent).toBe("two");
	});

	it("removing an attached item detaches it natively", () => {
		let keys = ["a", "b"];
		const { redraw, requestCell, attachedKeys } = mount(listView(() => keys));
		requestCell(0);
		requestCell(1);
		keys = ["b"];
		redraw();
		expect(attachedKeys()).toEqual(["b"]);
	});
});

describe("lifecycle", () => {
	it("list events reach the background handler", () => {
		const received: unknown[] = [];
		const { listHandle } = mount(() => m("list", { onscrolltolower: (e: any) => received.push(e.detail) }));
		for (const listener of listHandle().__vanillaListeners.scrolltolower) listener({ detail: { scrollTop: 10 } });
		expect(received).toEqual([{ scrollTop: 10 }]);
	});

	it("removed items run onremove", () => {
		const removed: string[] = [];
		let keys = ["a", "b"];
		const Row = { view: (v: any) => m("text", v.attrs.k), onremove: (v: any) => removed.push(v.attrs.k) };
		const { redraw } = mount(() => m("list", keys.map((k) => m("list-item", { key: k, "item-key": k }, m(Row, { k })))));
		keys = ["b"];
		redraw();
		expect(removed).toEqual(["a"]);
	});

	it("removing the list neutralizes its native callbacks and releases its items", () => {
		let show = true;
		const { redraw, listHandle, applier } = mount(() => (show ? m("list", [m("list-item", { key: "a", "item-key": "a" }, m("text", "a"))]) : m("view")));
		const handle = listHandle();
		const listID = __GetElementUniqueID(handle);
		show = false;
		redraw();
		expect(handle.componentAtIndex(handle, listID, 0, 1, false)).toBe(-1);
		expect(applier.getHandle(3)).toBeUndefined();
	});

	it("gesture worklets inside items are released with the list", () => {
		const registrySize = () => Object.keys((globalThis as any).lynxWorkletImpl?._workletMap ?? {}).length;
		let show = true;
		lynxTestingEnv.switchToMainThread();
		const before = registrySize();
		const { redraw } = mount(() =>
			show
				? m("list", [
						m(
							"list-item",
							{ key: "a", "item-key": "a", oncreate: (v: any) => v.dom.setGestureDetector("native", { mode: "claim" }) },
							m("text", "a"),
						),
					])
				: m("view"),
		);
		expect(registrySize()).toBe(before + 3);
		show = false;
		redraw();
		expect(registrySize()).toBe(before);
	});

	it("dispose() neutralizes every list", () => {
		const { applier, listHandle } = mount(listView(() => ["a"]));
		const handle = listHandle();
		applier.dispose();
		expect(handle.componentAtIndex(handle, __GetElementUniqueID(handle), 0, 1, false)).toBe(-1);
	});
});
