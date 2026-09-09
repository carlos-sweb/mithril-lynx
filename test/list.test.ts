import { describe, expect, it } from "@rstest/core";
import m from "mithril";
import shim from "../src/lynx-mithril-shim.js";
import { createList } from "../list.js";

const papiCalls = (): { fn: string; args: unknown[] }[] => (globalThis as any).__papiCalls;
const callsOf = (fn: string) => papiCalls().filter((c) => c.fn === fn);
const lastCallOf = (fn: string) => callsOf(fn).at(-1);

const shimModule = ((shim as any).default ?? shim) as {
  createPageWrapper(pageElement: unknown): unknown;
  render(rootWrapper: unknown, vnode: unknown): void;
};

function setupPage(): { rootWrapper: any } {
  lynxTestingEnv.switchToMainThread();
  const page = __CreatePage("0", 0);
  return { rootWrapper: shimModule.createPageWrapper(page) as any };
}

describe("list Tier 1 (m('list')/m('list-item') as ordinary tags)", () => {
  it("creates list/list-item via the generic element path and reorders via the existing keyed diff", () => {
    const { rootWrapper } = setupPage();
    const ids = ["a", "b", "c"];

    shimModule.render(
      rootWrapper,
      m(
        "list",
        { class: "my-list" },
        ids.map((id) => m("list-item", { key: id, id: `item-${id}` }, [m("text", null, id)])),
      ),
    );

    const list = rootWrapper.firstChild;
    expect(list._tag).toBe("list");
    expect(callsOf("__CreateElement").some((c) => c.args[0] === "list")).toBe(true);
    expect(callsOf("__CreateElement").filter((c) => c.args[0] === "list-item")).toHaveLength(3);
    expect(Array.from(list._handle.childNodes).map((n: any) => n.textContent)).toEqual(["a", "b", "c"]);

    // Reorder — exercises the SAME LIS keyed-diff path stress-tested in
    // keyed-diff.test.ts, now against list/list-item tags specifically.
    shimModule.render(
      rootWrapper,
      m(
        "list",
        { class: "my-list" },
        ["c", "a", "b"].map((id) => m("list-item", { key: id, id: `item-${id}` }, [m("text", null, id)])),
      ),
    );
    expect(Array.from(list._handle.childNodes).map((n: any) => n.textContent)).toEqual(["c", "a", "b"]);
    // No new list-item creations for a pure reorder.
    expect(callsOf("__CreateElement").filter((c) => c.args[0] === "list-item")).toHaveLength(3);
  });
});

describe("list Tier 2 (createList native-driven recycling)", () => {
  it("componentAtIndex creates a fresh list-item and flushes with the right options shape", () => {
    const { rootWrapper } = setupPage();
    const items = ["Alpha", "Bravo", "Charlie"];

    const list = createList(rootWrapper, {
      itemCount: items.length,
      renderItem: (index) => m("text", { class: "cell" }, items[index]),
    });
    rootWrapper.appendChild(list);

    const listId = __GetElementUniqueID(list._handle);
    const sign = (list._handle as any).componentAtIndex(list._handle, listId, 0, 111);

    expect(typeof sign).toBe("number");
    const flushCall = lastCallOf("__FlushElementTree");
    expect(flushCall?.args[1]).toEqual({ triggerLayout: true, operationID: 111, elementID: sign, listID: listId });

    const listItem = rootWrapper.firstChild.firstChild;
    expect(listItem._tag).toBe("list-item");
    expect(listItem.textContent).toBe("Alpha");
  });

  it("enqueueComponent recycles the same DOM subtree (diffed, not recreated) for a same-type cell", () => {
    const { rootWrapper } = setupPage();
    const items = ["Alpha", "Bravo", "Charlie", "Delta"];

    const list = createList(rootWrapper, {
      itemCount: items.length,
      renderItem: (index) => m("text", { class: "cell" }, items[index]),
    });
    rootWrapper.appendChild(list);
    const listId = __GetElementUniqueID(list._handle);

    const sign0 = (list._handle as any).componentAtIndex(list._handle, listId, 0, 1);
    const wrapperBefore = rootWrapper.firstChild.firstChild;
    expect(wrapperBefore.textContent).toBe("Alpha");

    // Native recycles cell 0's element, then asks for cell 3 (same type: "text").
    (list._handle as any).enqueueComponent(list._handle, listId, sign0);
    const createCountBefore = callsOf("__CreateElement").filter((c) => c.args[0] === "text" || c.args[0] === "list-item").length;
    const sign3 = (list._handle as any).componentAtIndex(list._handle, listId, 3, 2);
    const createCountAfter = callsOf("__CreateElement").filter((c) => c.args[0] === "text" || c.args[0] === "list-item").length;

    expect(sign3).toBe(sign0); // same underlying element, recycled
    expect(createCountAfter).toBe(createCountBefore); // no new elements created
    expect(rootWrapper.firstChild.firstChild.textContent).toBe("Delta"); // content updated in place
  });

  it("throws for an out-of-range cellIndex", () => {
    const { rootWrapper } = setupPage();
    const list = createList(rootWrapper, {
      itemCount: 2,
      renderItem: (index) => m("text", null, String(index)),
    });
    rootWrapper.appendChild(list);
    const listId = __GetElementUniqueID(list._handle);

    expect(() => (list._handle as any).componentAtIndex(list._handle, listId, 5, 1)).toThrow(/out of range/);
  });
});
