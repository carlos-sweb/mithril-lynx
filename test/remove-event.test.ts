import { describe, expect, it } from "@rstest/core";
import { createPatchApplier } from "../src/apply-patch.js";
import { Op } from "../src/patch-protocol.js";

// R3: Op.RemoveEvent must actually remove the native listener, not silently
// no-op — otherwise a remove→re-add cycle on a kept element accumulates
// duplicate native listeners and the app's handler fires N times per event
// (see informe-contrato-mithril-lynx.md §R3).
describe("Op.RemoveEvent removes the native listener (no duplicate-fire leak)", () => {
	it("AddEvent → RemoveEvent → AddEvent leaves exactly one listener", () => {
		lynxTestingEnv.switchToMainThread();
		const pageId = __GetElementUniqueID(__CreatePage());
		const applier = createPatchApplier(pageId);
		applier.registerPageRoot(__CreateView(pageId));

		applier.applyPatch([Op.CreateElement, "view", 1, Op.AddEvent, 1, "tap"]);
		const handle = applier.getHandle(1) as any;
		expect(handle.__vanillaListeners.tap.size).toBe(1);

		applier.applyPatch([Op.RemoveEvent, 1, "tap"]);
		expect(handle.__vanillaListeners.tap.size).toBe(0);

		applier.applyPatch([Op.AddEvent, 1, "tap"]);
		expect(handle.__vanillaListeners.tap.size).toBe(1);
	});
});
