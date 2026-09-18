import { describe, expect, it } from "@rstest/core";
import m from "mithril-runtime";
import { createRoute } from "../src/route.js";
import { Op } from "../src/patch-protocol.js";

// Regression test for a real, on-device-confirmed question (m-route-en-memoria.md
// §10 F6): does a stable-host screen re-render itself in place after
// module.hot.accept swaps its module, or does routing accidentally force a
// full teardown/recreate? Verified for real via a device trace: the actual
// patch for this exact shape was `[Op.SetText, id, "new text"]` — nothing
// else. This test locks that in.

describe("route.js + stable-host: a same-path re-resolve patches in place, never recreates", () => {
	it("swapping the live-bound view (module.hot.accept's job) produces only a SetText, no Create/Remove", () => {
		lynxTestingEnv.switchToMainThread();
		const capturedOps: unknown[][] = [];
		lynx.getJSContext().addEventListener("MithrilLynx:Patch", (event: any) => {
			capturedOps.push(event.data);
		});

		lynxTestingEnv.switchToBackgroundThread();
		const route = createRoute();
		// Same shape as the real app's background.ts: a stable host object
		// wrapping a live-bound `current*` reference, re-pointed by
		// module.hot.accept and re-resolved via route.set(..., {replace}).
		let currentDetail = { view: () => m("text", { key: "title" }, "first") };
		const DetailHost = { view: () => currentDetail.view() };

		route("/detail", { "/detail": DetailHost });
		capturedOps.length = 0; // only the re-resolve below matters

		currentDetail = { view: () => m("text", { key: "title" }, "second") };
		route.set(route.get() as string, null, { replace: true });

		const flat = capturedOps.flat();
		expect(flat).not.toContain(Op.CreateElement);
		expect(flat).not.toContain(Op.RemoveChild);
		expect(flat).toContain(Op.SetText);
	});
});
