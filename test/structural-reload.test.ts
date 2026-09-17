import { describe, expect, it } from "@rstest/core";
import m from "mithril";
import { Op } from "../src/patch-protocol.js";
import { createVirtualBackend } from "../src/backends/virtual-backend.js";
import { createLynxDocument } from "../src/fake-dom.js";
import renderFactory from "mithril/render/render.js";

// Tests the v2 plan's §3.6 hypothesis directly, WITHOUT a device: does
// re-rendering the SAME root/document with a structurally different tree
// (a sibling inserted next to an unrelated, focused-in-spirit node) reuse
// the unrelated node's id — i.e. does it survive as the SAME element,
// rather than being torn down and recreated? This is exactly what "reload
// B (estructural) doesn't lose the input's focus" depends on, and it's
// mithril's own diff doing the work, not a hand-written reconciler (see
// mithril-lynx-v2-desde-cero.md §3.6).
//
// This does not replace on-device verification (F4) — it verifies the
// PART of the hypothesis that's actually testable off-device: id/identity
// stability across a structural re-render. Whether the real native
// `<input>` keeps keyboard focus and in-progress text is a device-only
// question (F4's real acceptance criterion).

describe("structural re-render reuses unrelated nodes (v2 plan §3.6 hypothesis)", () => {
	it("does not recreate a sibling `input`-like node when a new node is inserted next to it", () => {
		const backend = createVirtualBackend();
		const document = createLynxDocument(backend);
		const render = renderFactory();

		function redraw() {
			render(document, view(), redraw);
		}

		// `key` on every sibling is load-bearing here, not decoration: this is
		// exactly the discipline the plan's §3.6 calls out as required for
		// Mithril's own (unkeyed-diff) middle-insertion trap to not apply —
		// without keys, an unkeyed diff treats "insert in the middle" as
		// "index 1 changed tag" and recreates everything from that index on,
		// which is a real Mithril behavior, not a v2 bug. The un-keyed case
		// is deliberately NOT what this test asserts.
		let showExtra = false;
		function view() {
			const children = [m("view", { key: "a", class: "a" }, "A")];
			if (showExtra) children.push(m("view", { key: "extra", class: "extra" }, "EXTRA"));
			children.push(m("input", { key: "input", class: "focused-input" }));
			return m("view", { class: "root" }, children);
		}

		redraw();
		backend.takeOps(); // discard the initial patch — we only care about the DELTA below

		// Capture the input's id BEFORE the structural change, by walking
		// the fake-dom tree the same way app code never has to (test-only
		// introspection): the root element's last child is the input.
		const rootEl = document.firstChild as any;
		const inputBefore = rootEl._children[rootEl._children.length - 1];
		const inputIdBefore = inputBefore._id;

		showExtra = true;
		redraw();
		const deltaOps = backend.takeOps() ?? [];

		// The decisive check: no RemoveChild/CreateElement op in the delta
		// touches the input's id — it was reused in place, only a new
		// sibling was created and inserted before it.
		const ARITY = {
			[Op.CreateElement]: 2,
			[Op.CreateElementNS]: 3,
			[Op.CreateText]: 2,
			[Op.InsertBefore]: 3,
			[Op.RemoveChild]: 2,
			[Op.SetAttribute]: 3,
			[Op.RemoveAttribute]: 2,
			[Op.SetAttributeNS]: 4,
			[Op.SetStyleProperty]: 3,
			[Op.RemoveStyleProperty]: 2,
			[Op.SetText]: 2,
			[Op.AddEvent]: 2,
			[Op.RemoveEvent]: 2,
		} as Record<number, number>;
		for (let i = 0; i < deltaOps.length; ) {
			const opcode = deltaOps[i++] as number;
			const args = deltaOps.slice(i, i + ARITY[opcode]);
			if (opcode === Op.CreateElement) {
				expect(args[1]).not.toBe(inputIdBefore);
			} else if (opcode === Op.RemoveChild) {
				expect(args[1]).not.toBe(inputIdBefore);
			}
			i += ARITY[opcode];
		}

		const rootElAfter = document.firstChild as any;
		const inputAfter = rootElAfter._children[rootElAfter._children.length - 1];
		expect(inputAfter._id).toBe(inputIdBefore);
	});
});
