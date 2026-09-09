import { describe, expect, it } from "@rstest/core";
import shim from "../src/lynx-mithril-shim.js";
import m from "mithril";

// Stress-tests the shim's ported LIS-based keyed-diff path (render.js's
// bottom-up/top-down/swap/LIS branches), which mithril-app's own README
// flagged as "exists but never stress-tested." A reorder must MOVE existing
// wrapper nodes, never destroy+recreate them — that's the whole point of
// keying, and the property this suite asserts directly via oncreate/onremove
// lifecycle counts, not just final DOM order.

type Wrapper = {
  _tag: string;
  _handle: any;
  textContent: string;
};

const shimModule = ((shim as any).default ?? shim) as {
  createPageWrapper(pageElement: unknown): unknown;
  render(rootWrapper: unknown, vnode: unknown): void;
};

const domOrder = (parent: Wrapper): unknown[] => Array.from(parent._handle.childNodes);

const setup = (): { rootWrapper: Wrapper } => {
  lynxTestingEnv.switchToMainThread();
  const page = __CreatePage("0", 0);
  return { rootWrapper: shimModule.createPageWrapper(page) as Wrapper };
};

// Renders a keyed list of items (each item's text is its id) and tracks
// create/remove lifecycle events per key so tests can assert identity
// preservation across reorders.
function renderList(
  rootWrapper: Wrapper,
  ids: string[],
  created: string[],
  removed: string[],
): void {
  shimModule.render(
    rootWrapper,
    m(
      "view",
      { id: "list" },
      ids.map((id) =>
        m("text", {
          key: id,
          oncreate: () => created.push(id),
          onremove: () => removed.push(id),
        }, id),
      ),
    ),
  );
}

function getList(rootWrapper: Wrapper): Wrapper {
  return (rootWrapper as any).firstChild as Wrapper;
}

describe("lynx-mithril-shim keyed diff (LIS reorder)", () => {
  it("full reversal moves every node, recreating none", () => {
    const { rootWrapper } = setup();
    const created: string[] = [];
    const removed: string[] = [];
    const ids = ["a", "b", "c", "d", "e"];

    renderList(rootWrapper, ids, created, removed);
    const list = getList(rootWrapper);
    expect(domOrder(list).map((n: any) => n._tag ? n : n)).toHaveLength(5);
    expect(created).toEqual(["a", "b", "c", "d", "e"]);

    renderList(rootWrapper, [...ids].reverse(), created, removed);

    // Final order matches the new vnode order.
    expect(domOrder(list).map((n: any) => n.textContent)).toEqual(["e", "d", "c", "b", "a"]);
    // No node was destroyed or recreated for a pure reorder.
    expect(created).toEqual(["a", "b", "c", "d", "e"]);
    expect(removed).toEqual([]);
  });

  it("shuffle preserves identity for every surviving key", () => {
    const { rootWrapper } = setup();
    const created: string[] = [];
    const removed: string[] = [];
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    renderList(rootWrapper, ids, created, removed);
    const list = getList(rootWrapper);

    // A handful of permutations exercising bottom-up/top-down/swap/LIS paths.
    const permutations = [
      ["g", "f", "e", "d", "c", "b", "a"], // full reversal
      ["a", "g", "b", "f", "c", "e", "d"], // interleaved
      ["d", "c", "b", "a", "g", "f", "e"], // rotation
      ["a", "b", "c", "d", "e", "f", "g"], // back to original
    ];

    for (const order of permutations) {
      renderList(rootWrapper, order, created, removed);
      expect(domOrder(list).map((n: any) => n.textContent)).toEqual(order);
    }

    // Across all four re-renders, every key was created exactly once and
    // never removed — pure moves throughout.
    expect(created).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(removed).toEqual([]);
  });

  it("add/remove interleaved with reorder: only genuinely absent keys are removed", () => {
    const { rootWrapper } = setup();
    const created: string[] = [];
    const removed: string[] = [];
    renderList(rootWrapper, ["a", "b", "c"], created, removed);
    const list = getList(rootWrapper);

    // Remove "b", add "d" and "e", and reorder in one pass.
    renderList(rootWrapper, ["e", "c", "a", "d"], created, removed);

    expect(domOrder(list).map((n: any) => n.textContent)).toEqual(["e", "c", "a", "d"]);
    expect(created).toEqual(["a", "b", "c", "d", "e"]);
    expect(removed).toEqual(["b"]);

    // Remove everything, then rebuild from scratch.
    renderList(rootWrapper, [], created, removed);
    expect(domOrder(list)).toEqual([]);
    expect(removed).toEqual(["b", "e", "c", "a", "d"]);

    renderList(rootWrapper, ["a", "c"], created, removed);
    expect(domOrder(list).map((n: any) => n.textContent)).toEqual(["a", "c"]);
  });
});
