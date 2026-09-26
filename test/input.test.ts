import { afterEach, describe, expect, it } from "@rstest/core";
import m from "mithril-runtime";
import { createPatchApplier } from "../src/apply-patch.js";
import { renderApp } from "../src/background.js";
import { unregister } from "../src/mount-redraw.js";
import { forEachOp, Op } from "../src/patch-protocol.js";
import { setUIMethodResponder, uiMethodCalls } from "../src/testing.js";

// <input>/<textarea> have no `value` attribute natively, only UI methods
// (setValue, focus, …). fake-dom.js gives them a real `value` property that
// sends Op.SetInputValue, synced back from every forwarded event, and
// apply-patch.js runs UI methods right after the patch's flush — so
// `m("input", { value, autofocus })` works like Mithril on the web, with no
// id, timer or selector query.

type Forwarded = { id: number; type: string; payload: unknown; seq?: number };

function mount(view: () => unknown) {
	lynxTestingEnv.switchToMainThread();
	const pageId = __GetElementUniqueID(__CreatePage());
	const toBackground: Forwarded[] = [];
	const applier = createPatchApplier(pageId, {
		onEvent: (id: number, type: string, payload: unknown, seq?: number) =>
			toBackground.push(seq === undefined ? { id, type, payload } : { id, type, payload, seq }),
	});
	applier.registerPageRoot(__CreateView(pageId));

	lynxTestingEnv.switchToBackgroundThread();
	unregister();
	const patches: unknown[][] = [];
	let router: (event: { data: Forwarded }) => void = () => {};
	const app = renderApp({
		root: view,
		sendPatch: (ops) => patches.push(ops),
		subscribeEvents: (handler: any) => {
			router = handler;
		},
	});

	let applied = 0;
	/** Delivers what the main thread forwarded (events, invoke results). */
	const deliver = () => {
		while (toBackground.length > 0) router({ data: toBackground.shift()! });
	};
	/** Applies every new patch on the main thread, then delivers what it forwarded. */
	const sync = () => {
		const fresh = patches.slice(applied);
		applied = patches.length;
		lynxTestingEnv.switchToMainThread();
		for (const ops of fresh) applier.applyPatch(ops);
		lynxTestingEnv.switchToBackgroundThread();
		deliver();
		return fresh;
	};
	/** Fires a native event on the main thread, as native would. */
	const fireNative = (node: any, type: string, detail: Record<string, unknown>) => {
		lynxTestingEnv.switchToMainThread();
		const handle: any = applier.getHandle(node._id);
		for (const listener of handle.__vanillaListeners?.[type] ?? []) listener({ type, detail });
		lynxTestingEnv.switchToBackgroundThread();
		deliver();
	};
	const handleOf = (node: any) => applier.getHandle(node._id);
	return { app, patches, sync, fireNative, handleOf, applier, deliver };
}

function uiCalls(handle: unknown) {
	return uiMethodCalls.filter((c) => c.element === handle).map((c) => [c.method, c.params]);
}

function opsOf(patches: unknown[][], opcode: number) {
	const out: unknown[][] = [];
	for (const ops of patches) forEachOp(ops, (code, args) => code === opcode && out.push(args));
	return out;
}

afterEach(() => {
	uiMethodCalls.length = 0;
	setUIMethodResponder(null);
});

describe("<input> value", () => {
	it("an initial value is one setValue, with no id, run once the element is in the tree", () => {
		// The UI method runs after the whole patch — including the insert of
		// the element that the same patch created — has been applied.
		const parentsAtInvoke: unknown[] = [];
		setUIMethodResponder((element: any) => {
			parentsAtInvoke.push(element.parentNode);
			return { code: 0 };
		});
		let field: any;
		const { sync, handleOf } = mount(() => m("view", m("input", { value: "hola", oncreate: (v: any) => (field = v.dom) })));
		sync();
		expect(uiCalls(handleOf(field))).toEqual([["setValue", { value: "hola" }]]);
		expect(parentsAtInvoke).toHaveLength(1);
		expect(parentsAtInvoke[0]).toBeTruthy();
		expect(field.value).toBe("hola");
	});

	it("an empty or absent value sends nothing", () => {
		const { sync } = mount(() => m("view", [m("input", { value: "" }), m("input", {}), m("textarea", {})]));
		sync();
		expect(uiMethodCalls).toEqual([]);
	});

	it("text the user typed is not sent back (Mithril sees dom.value already equal)", () => {
		let text = "";
		let field: any;
		const { sync, fireNative, handleOf } = mount(() =>
			m("input", { value: text, oncreate: (v: any) => (field = v.dom), oninput: (e: any) => (text = e.detail.value) }),
		);
		sync();
		fireNative(field, "input", { value: "a", selectionStart: 1, selectionEnd: 1 });
		fireNative(field, "input", { value: "ab", selectionStart: 2, selectionEnd: 2 });
		sync();
		expect(text).toBe("ab");
		expect(field.value).toBe("ab");
		expect(field.selectionStart).toBe(2);
		expect(uiCalls(handleOf(field))).toEqual([]);
	});

	it("a value the app transforms is sent once", () => {
		let text = "";
		let field: any;
		const { sync, fireNative, handleOf } = mount(() =>
			m("input", { value: text, oncreate: (v: any) => (field = v.dom), oninput: (e: any) => (text = e.detail.value.toUpperCase()) }),
		);
		sync();
		fireNative(field, "input", { value: "ab" });
		sync();
		expect(uiCalls(handleOf(field))).toEqual([["setValue", { value: "AB" }]]);
		// The native echo of that setValue changes nothing.
		fireNative(field, "input", { value: "AB" });
		sync();
		expect(uiCalls(handleOf(field))).toHaveLength(1);
	});

	it("a clear from another event (a button) is sent", () => {
		let text = "";
		let field: any;
		let button: any;
		const { sync, fireNative, handleOf } = mount(() =>
			m("view", [
				m("input", { value: text, oncreate: (v: any) => (field = v.dom), oninput: (e: any) => (text = e.detail.value) }),
				m("view", { oncreate: (v: any) => (button = v.dom), ontap: () => (text = "") }),
			]),
		);
		sync();
		fireNative(field, "input", { value: "hola" });
		sync();
		fireNative(button, "tap", {});
		sync();
		expect(uiCalls(handleOf(field))).toEqual([["setValue", { value: "" }]]);
	});

	it("removing the value attribute clears the field", () => {
		let attrs: Record<string, unknown> = { value: "x" };
		let field: any;
		const { app, sync, handleOf } = mount(() => m("input", { ...attrs, oncreate: (v: any) => (field = v.dom) }));
		sync();
		attrs = {};
		app.redraw();
		sync();
		expect(uiCalls(handleOf(field))).toEqual([
			["setValue", { value: "x" }],
			["setValue", { value: "" }],
		]);
	});

	it("a value computed before a newer keystroke is dropped on the main thread", () => {
		let text = "";
		let field: any;
		const { sync, fireNative, handleOf } = mount(() =>
			m("input", { value: text, oncreate: (v: any) => (field = v.dom), oninput: (e: any) => (text = e.detail.value.toUpperCase()) }),
		);
		sync();
		fireNative(field, "input", { value: "a" }); // background renders "A" (seq 1)
		// Before that patch is applied, the user types again: native counts seq 2.
		lynxTestingEnv.switchToMainThread();
		const handle: any = handleOf(field);
		for (const listener of handle.__vanillaListeners.input) listener({ type: "input", detail: { value: "ab" } });
		lynxTestingEnv.switchToBackgroundThread();
		sync(); // applies "A" with seq 1 < 2: dropped; then delivers "ab"
		expect(uiCalls(handle)).toEqual([]);
		sync(); // the "ab" event's render sends "AB" with seq 2
		expect(uiCalls(handle)).toEqual([["setValue", { value: "AB" }]]);
		expect(text).toBe("AB");
	});

	it("a native input event that doesn't change the text is not forwarded (creation, setValue echo)", () => {
		// Seen on device: a <textarea> fires `input ""` by itself while it is
		// first flushed, and native echoes every setValue as an `input`.
		// Forwarded, the first would hand the app a spurious "" (wiping a
		// controlled field's state) and count as a keystroke, dropping the
		// field's initial setValue.
		const seen: string[] = [];
		let text = "inicial";
		let field: any;
		const { patches, fireNative, handleOf, applier, deliver } = mount(() =>
			m("textarea", {
				value: text,
				oncreate: (v: any) => (field = v.dom),
				oninput: (e: any) => {
					seen.push(e.detail.value);
					text = e.detail.value;
				},
			}),
		);
		// Native's spurious `input ""`, fired from inside the patch's flush —
		// before the patch's setValue runs. Applied by hand: switching
		// threads re-injects the globals, which would drop the override.
		lynxTestingEnv.switchToMainThread();
		const realFlush = (globalThis as any).__FlushElementTree;
		let spurious = 0;
		(globalThis as any).__FlushElementTree = (...args: unknown[]) => {
			const handle: any = applier.getHandle(field._id);
			if (spurious++ === 0) for (const listener of handle.__vanillaListeners.input) listener({ type: "input", detail: { value: "" } });
			return realFlush(...args);
		};
		for (const ops of patches) applier.applyPatch(ops);
		(globalThis as any).__FlushElementTree = realFlush;
		lynxTestingEnv.switchToBackgroundThread();
		deliver();
		expect(spurious).toBeGreaterThan(0);
		fireNative(field, "input", { value: "inicial" }); // the setValue echo
		expect(seen).toEqual([]);
		expect(text).toBe("inicial");
		expect(uiCalls(handleOf(field))).toEqual([["setValue", { value: "inicial" }]]);

		fireNative(field, "input", { value: "inicial!" });
		expect(seen).toEqual(["inicial!"]);
	});

	it("an unchanged text still forwards a change of composition state", () => {
		const seen: unknown[] = [];
		let field: any;
		const { sync, fireNative } = mount(() =>
			m("input", { oncreate: (v: any) => (field = v.dom), oninput: (e: any) => seen.push([e.detail.value, e.detail.isComposing]) }),
		);
		sync();
		fireNative(field, "input", { value: "ni", isComposing: true });
		fireNative(field, "input", { value: "ni", isComposing: false });
		fireNative(field, "input", { value: "ni", isComposing: false });
		expect(seen).toEqual([
			["ni", true],
			["ni", false],
		]);
	});

	it("textarea behaves the same", () => {
		let text = "uno";
		let field: any;
		const { sync, fireNative, handleOf } = mount(() =>
			m("textarea", { value: text, oncreate: (v: any) => (field = v.dom), oninput: (e: any) => (text = e.detail.value) }),
		);
		sync();
		fireNative(field, "input", { value: "uno dos" });
		sync();
		expect(uiCalls(handleOf(field))).toEqual([["setValue", { value: "uno" }]]);
		expect(field.value).toBe("uno dos");
	});

	it("focus/blur/confirm events sync dom.value too", () => {
		let field: any;
		const { sync, fireNative } = mount(() => m("input", { oncreate: (v: any) => (field = v.dom), onblur: () => {} }));
		sync();
		fireNative(field, "blur", { value: "typed" });
		expect(field.value).toBe("typed");
	});
});

describe("focus", () => {
	it("autofocus focuses once, on creation, and never again on redraw", () => {
		let field: any;
		const { app, sync, handleOf } = mount(() => m("input", { autofocus: true, oncreate: (v: any) => (field = v.dom) }));
		sync();
		app.redraw();
		sync();
		expect(uiCalls(handleOf(field))).toEqual([["focus", {}]]);
	});

	it("dom.focus() and dom.blur() from oncreate", () => {
		let field: any;
		const { sync, handleOf } = mount(() =>
			m("input", {
				oncreate: (v: any) => {
					field = v.dom;
					v.dom.focus();
				},
			}),
		);
		sync();
		field.blur();
		return Promise.resolve().then(() => {
			sync();
			expect(uiCalls(handleOf(field))).toEqual([
				["focus", {}],
				["blur", {}],
			]);
		});
	});

	it("dom.focus() outside a render is sent on its own at the end of the task", async () => {
		let field: any;
		const { patches, sync, handleOf } = mount(() => m("input", { oncreate: (v: any) => (field = v.dom) }));
		sync();
		const before = patches.length;
		field.focus();
		expect(patches.length).toBe(before);
		await Promise.resolve();
		expect(patches.length).toBe(before + 1);
		expect(opsOf(patches.slice(before), Op.InvokeUIMethod)).toEqual([[field._id, "focus", {}, 0]]);
		sync();
		expect(uiCalls(handleOf(field))).toEqual([["focus", {}]]);
	});

	it("Mithril's post-render focus restoration never calls focus()", () => {
		let show = true;
		const { app, sync } = mount(() => m("view", show ? [m("input", { key: "a" }), m("input", { key: "b" })] : [m("input", { key: "b" })]));
		sync();
		show = false;
		app.redraw();
		sync();
		expect(uiMethodCalls).toEqual([]);
	});
});

describe("dom.invoke()", () => {
	it("resolves with the method's data", async () => {
		setUIMethodResponder((_e, method) => (method === "getValue" ? { code: 0, data: { value: "hola", selectionStart: 4, selectionEnd: 4 } } : { code: 0 }));
		let field: any;
		const { sync } = mount(() => m("input", { oncreate: (v: any) => (field = v.dom) }));
		sync();
		const result = field.invoke("getValue");
		await Promise.resolve();
		sync();
		await expect(result).resolves.toEqual({ value: "hola", selectionStart: 4, selectionEnd: 4 });
	});

	it("works on any element (e.g. a scroll-view method) and passes params", async () => {
		let scroller: any;
		const { sync, handleOf } = mount(() => m("scroll-view", { oncreate: (v: any) => (scroller = v.dom) }));
		sync();
		const done = scroller.invoke("scrollTo", { offset: 120, smooth: true });
		await Promise.resolve();
		sync();
		await expect(done).resolves.toBeUndefined();
		expect(uiCalls(handleOf(scroller))).toEqual([["scrollTo", { offset: 120, smooth: true }]]);
	});

	it("rejects with the native code and data", async () => {
		setUIMethodResponder(() => ({ code: 4, data: "no such method" }));
		let field: any;
		const { sync } = mount(() => m("input", { oncreate: (v: any) => (field = v.dom) }));
		sync();
		const result = field.invoke("nope");
		await Promise.resolve();
		sync();
		await expect(result).rejects.toMatchObject({ code: 4, data: "no such method" });
	});

	it("rejects when the element is removed by the same patch", async () => {
		let show = true;
		let field: any;
		let pending: Promise<unknown> | undefined;
		const { app, sync } = mount(() =>
			m("view", show ? m("input", { oncreate: (v: any) => (field = v.dom) }) : null),
		);
		sync();
		pending = field.invoke("getValue");
		show = false;
		app.redraw();
		sync();
		await expect(pending).rejects.toThrow(/removed/);
		expect(uiMethodCalls).toEqual([]);
	});

	it("setSelectionRange is a UI method call", async () => {
		let field: any;
		const { sync, handleOf } = mount(() => m("input", { oncreate: (v: any) => (field = v.dom) }));
		sync();
		const done = field.setSelectionRange(1, 3);
		await Promise.resolve();
		sync();
		await done;
		expect(uiCalls(handleOf(field))).toEqual([["setSelectionRange", { selectionStart: 1, selectionEnd: 3 }]]);
	});
});
