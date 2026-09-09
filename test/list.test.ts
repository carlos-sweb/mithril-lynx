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
  it("sets scroll-orientation/list-type/span-count on the list — required by native, not optional (see LIST_INVESTIGATION.md)", () => {
    const { rootWrapper } = setupPage();
    const list = createList(rootWrapper, {
      itemCount: 3,
      renderItem: (index) => m("text", null, String(index)),
    });
    rootWrapper.appendChild(list);

    const attrCalls = callsOf("__SetAttribute").filter((c) => c.args[0] === list._handle);
    expect(attrCalls).toEqual(
      expect.arrayContaining([
        { fn: "__SetAttribute", args: [list._handle, "scroll-orientation", "vertical"] },
        { fn: "__SetAttribute", args: [list._handle, "list-type", "single"] },
        { fn: "__SetAttribute", args: [list._handle, "span-count", "1"] },
      ]),
    );
  });

  it("accepts scrollOrientation/listType/spanCount overrides", () => {
    const { rootWrapper } = setupPage();
    const list = createList(rootWrapper, {
      itemCount: 3,
      renderItem: (index) => m("text", null, String(index)),
      scrollOrientation: "horizontal",
      listType: "flow",
      spanCount: 2,
    });
    rootWrapper.appendChild(list);

    const attrCalls = callsOf("__SetAttribute").filter((c) => c.args[0] === list._handle);
    expect(attrCalls).toEqual(
      expect.arrayContaining([
        { fn: "__SetAttribute", args: [list._handle, "scroll-orientation", "horizontal"] },
        { fn: "__SetAttribute", args: [list._handle, "list-type", "flow"] },
        { fn: "__SetAttribute", args: [list._handle, "span-count", "2"] },
      ]),
    );
  });

  it("sends update-list-info + __UpdateListCallbacks on creation — the piece that actually makes native call componentAtIndex (see LIST_INVESTIGATION.md)", () => {
    const { rootWrapper } = setupPage();
    const list = createList(rootWrapper, {
      itemCount: 3,
      renderItem: (index) => m("text", null, String(index)),
    });
    rootWrapper.appendChild(list);

    const infoCall = callsOf("__SetAttribute").find(
      (c) => c.args[0] === list._handle && c.args[1] === "update-list-info",
    );
    expect(infoCall?.args[2]).toEqual({
      insertAction: [
        { position: 0, type: "cell", "item-key": "0" },
        { position: 1, type: "cell", "item-key": "1" },
        { position: 2, type: "cell", "item-key": "2" },
      ],
      removeAction: [],
      updateAction: [],
    });
    expect(callsOf("__UpdateListCallbacks").at(-1)?.args[0]).toBe(list._handle);
  });

  it("setItemCount sends an incremental insertAction when growing, removeAction when shrinking", () => {
    const { rootWrapper } = setupPage();
    const list = createList(rootWrapper, {
      itemCount: 3,
      renderItem: (index) => m("text", null, String(index)),
    });
    rootWrapper.appendChild(list);

    list.setItemCount(5);
    let infoCall = callsOf("__SetAttribute").filter(
      (c) => c.args[0] === list._handle && c.args[1] === "update-list-info",
    ).at(-1);
    expect(infoCall?.args[2]).toEqual({
      insertAction: [
        { position: 3, type: "cell", "item-key": "3" },
        { position: 4, type: "cell", "item-key": "4" },
      ],
      removeAction: [],
      updateAction: [],
    });

    list.setItemCount(2);
    infoCall = callsOf("__SetAttribute").filter(
      (c) => c.args[0] === list._handle && c.args[1] === "update-list-info",
    ).at(-1);
    expect(infoCall?.args[2]).toEqual({ insertAction: [], removeAction: [2, 3, 4], updateAction: [] });

    // Unchanged count sends nothing new.
    const callCountBefore = callsOf("__SetAttribute").filter((c) => c.args[1] === "update-list-info").length;
    list.setItemCount(2);
    expect(callsOf("__SetAttribute").filter((c) => c.args[1] === "update-list-info")).toHaveLength(callCountBefore);
  });

  it("componentAtIndex creates a fresh list-item, sets its item-key, and flushes with the right options shape", () => {
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
    const itemKeyCall = callsOf("__SetAttribute").find((c) => c.args[0] === listItem._handle);
    expect(itemKeyCall?.args).toEqual([listItem._handle, "item-key", "0"]);
  });

  it("uses a custom itemKey function when given", () => {
    const { rootWrapper } = setupPage();
    const list = createList(rootWrapper, {
      itemCount: 3,
      renderItem: (index) => m("text", null, String(index)),
      itemKey: (index) => `row-${index}`,
    });
    rootWrapper.appendChild(list);
    const listId = __GetElementUniqueID(list._handle);

    (list._handle as any).componentAtIndex(list._handle, listId, 2, 1);
    const listItem = rootWrapper.firstChild.firstChild;
    const itemKeyCall = callsOf("__SetAttribute").find((c) => c.args[0] === listItem._handle);
    expect(itemKeyCall?.args).toEqual([listItem._handle, "item-key", "row-2"]);
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

    // item-key must follow the recycled cell to its NEW index, not stay "0".
    const itemKeyCalls = callsOf("__SetAttribute").filter(
      (c) => c.args[0] === wrapperBefore._handle && c.args[1] === "item-key",
    );
    expect(itemKeyCalls.map((c) => c.args[2])).toEqual(["0", "3"]);
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
