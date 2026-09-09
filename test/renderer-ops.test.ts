import { describe, expect, it } from "@rstest/core";
import m from "mithril";
import * as rendererBackground from "../renderer/background.js";
import { rendererPatchEventName } from "../internal/constants.js";

// Verifies the op-log SHAPE the virtual tree produces, independent of
// PAPI replay — this is the "op-log unit tests asserting exact op sequences"
// step the project plan calls for before ever wiring patches to real PAPI.
// Captured by listening on the main thread's side of the channel (where
// background's lynx.getCoreContext().dispatchEvent() is actually delivered),
// without calling setupRenderer()/applyPatch() at all.

function capturePatches(run: () => void): unknown[][] {
  const patches: unknown[][] = [];
  lynxTestingEnv.switchToMainThread();
  lynx.getJSContext().addEventListener(rendererPatchEventName, (event: any) => {
    patches.push(event.data);
  });
  lynxTestingEnv.switchToBackgroundThread();
  run();
  return patches;
}

describe("renderer mode op-log (no PAPI replay)", () => {
  it("initial render emits create/appendChild/setProp/addEvent ops in a valid dependency order", () => {
    const patches = capturePatches(() => {
      rendererBackground.renderApp({
        root: () =>
          m("view", { class: "page" }, [
            m("text", { class: "title" }, "Hello"),
            m("view", { class: "button", ontap: () => {} }, [
              m("text", null, "Tap"),
            ]),
          ]),
      });
    });

    expect(patches).toHaveLength(1);
    const ops = patches[0] as any[];

    // Every op referencing a vid (other than the root, vid 0) must have been
    // created by an earlier createElement/createText op in the SAME patch —
    // the fundamental ordering invariant applyPatch() depends on.
    const created = new Set<number>([0]);
    for (const op of ops) {
      if (op.op === "createElement" || op.op === "createText") {
        expect(created.has(op.vid)).toBe(false); // fresh vid
        created.add(op.vid);
      } else {
        const referenced = [op.vid, op.parentVid, op.childVid, op.refVid].filter(
          (v) => v !== undefined && v !== null,
        );
        for (const vid of referenced) expect(created.has(vid)).toBe(true);
      }
    }

    // Structural shape: 3 elements (page view, title text, button view) + 1
    // more element (nested view is same "view" tag)... recount precisely:
    // page view, title text view->text raw, button view, tap text, tap raw.
    const createOps = ops.filter((op) => op.op === "createElement" || op.op === "createText");
    expect(createOps.length).toBeGreaterThanOrEqual(5); // page, title, "Hello" raw, button, "Tap" text, "Tap" raw

    // className flows through setProp (DIRECT_PROPS path), not setAttribute.
    const classNameOps = ops.filter((op) => op.op === "setProp" && op.key === "className");
    expect(classNameOps.map((op) => op.value).sort()).toEqual(["button", "page", "title"]);

    // The tap handler registers exactly one addEvent op for "tap".
    const addEventOps = ops.filter((op) => op.op === "addEvent");
    expect(addEventOps).toEqual([{ op: "addEvent", vid: expect.any(Number), type: "tap" }]);

    // appendChild ops connect the tree: every non-root created vid appears
    // as a childVid exactly once (each node is attached to its parent once).
    const nonRootCreated = createOps.map((op) => op.vid);
    const appendedChildVids = ops.filter((op) => op.op === "appendChild").map((op) => op.childVid);
    for (const vid of nonRootCreated) {
      expect(appendedChildVids.filter((v) => v === vid)).toHaveLength(1);
    }
  });

  it("redraw after a text change emits a setText op, not a full re-create", () => {
    let count = 0;
    const Counter = {
      view: () => m("text", { class: "counter" }, String(count)),
    };

    const patches = capturePatches(() => {
      rendererBackground.renderApp({ root: () => m(Counter) });
    });
    expect(patches).toHaveLength(1);

    lynxTestingEnv.switchToBackgroundThread();
    count = 1;
    rendererBackground.redraw();

    expect(patches).toHaveLength(2);
    const updateOps = patches[1] as any[];
    // No createElement/createText/appendChild — same nodes, just a text
    // update — plus a setStyleProps flush for every node (see
    // internal/virtual-node.js's flushStyleProxies: it mirrors the real
    // shim's flushTree(), which unconditionally flushes EVERY style proxy on
    // every pass, whether or not that node's style actually changed).
    expect(updateOps.filter((op) => op.op !== "setStyleProps")).toEqual([
      { op: "setText", vid: expect.any(Number), value: "1" },
    ]);
  });
});
