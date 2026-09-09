import { describe, expect, it, rs } from "@rstest/core";
import shim from "../src/lynx-mithril-shim.js";
import m from "mithril";

type Wrapper = {
  nodeType: number;
  _tag: string;
  _handle: any;
  ownerDocument: any;
  addEventListener(type: string, listener: unknown, opts?: unknown): void;
  removeEventListener(type: string, listener: unknown, opts?: unknown): void;
};

type PapiCall = { fn: string; args: unknown[] };

const shimModule = ((shim as any).default ?? shim) as {
  createPageWrapper(pageElement: unknown): unknown;
  render(rootWrapper: unknown, vnode: unknown): void;
};

const papiCalls = (): PapiCall[] => (globalThis as any).__papiCalls as PapiCall[];
const callsOf = (fn: string): PapiCall[] => papiCalls().filter((c) => c.fn === fn);

const storedListeners = (
  node: any,
  type: string,
): Set<(...args: any[]) => unknown> => node.__vanillaListeners?.[type] ?? new Set();

const setup = (): { page: any; rootWrapper: Wrapper } => {
  lynxTestingEnv.switchToMainThread();
  const page = __CreatePage("0", 0);
  return { page, rootWrapper: shimModule.createPageWrapper(page) as Wrapper };
};

describe("lynx-mithril-shim events", () => {
  it("delivers events to an EventDict via handleEvent", () => {
    const { rootWrapper } = setup();
    const doc = rootWrapper.ownerDocument;
    const view = doc.createElement("view") as Wrapper;

    const handleEvent = rs.fn(() => {});
    view.addEventListener("tap", { handleEvent }, {});

    for (const handler of storedListeners(view._handle, "tap")) {
      handler({ type: "tap" });
    }

    expect(handleEvent).toHaveBeenCalledTimes(1);
    const ev = handleEvent.mock.calls[0][0];
    expect(ev.type).toBe("tap");
    expect(ev.currentTarget).toBe(view);
    expect(ev.redraw).toBe(false);
  });

  it("maps ontap to __AddEventListener(node, \"tap\", fn, {})", () => {
    const { rootWrapper } = setup();
    const handler = rs.fn(() => {});

    shimModule.render(rootWrapper, m("view", { ontap: handler }));

    const add = callsOf("__AddEventListener").at(-1);
    expect(add?.args[1]).toBe("tap");
    expect(typeof add?.args[2]).toBe("function");
    expect(add?.args[3]).toEqual({});

    // Simulate the tap: the stored listener is the shim's wrapped handler.
    const node = add?.args[0] as any;
    for (const stored of storedListeners(node, "tap")) {
      stored({ type: "tap" });
    }
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("removes listeners per type", () => {
    const { rootWrapper } = setup();
    const onTap = rs.fn(() => {});
    const onClick = rs.fn(() => {});

    shimModule.render(rootWrapper, m("view", { ontap: onTap, onclick: onClick }));
    const node = callsOf("__AddEventListener").at(-1)?.args[0] as any;
    expect(storedListeners(node, "tap").size).toBe(1);
    expect(storedListeners(node, "click").size).toBe(1);

    // Re-render without ontap → only the tap listener is removed.
    shimModule.render(rootWrapper, m("view", { onclick: onClick }));

    const remove = callsOf("__RemoveEventListener").at(-1);
    expect(remove?.args[1]).toBe("tap");
    expect(storedListeners(node, "tap").size).toBe(0);
    expect(storedListeners(node, "click").size).toBe(1);
  });

  it("normalizes the raw Lynx event object", () => {
    const { rootWrapper } = setup();
    const doc = rootWrapper.ownerDocument;
    const view = doc.createElement("view") as Wrapper;

    const handler = rs.fn(() => {});
    view.addEventListener("tap", handler, {});

    for (const stored of storedListeners(view._handle, "tap")) {
      stored({ type: "tap", detail: 7 });
    }

    expect(handler).toHaveBeenCalledTimes(1);
    const ev = handler.mock.calls[0][0];
    expect(ev.type).toBe("tap");
    expect(ev.currentTarget).toBe(view);
    expect(ev.redraw).toBe(false);
    expect(typeof ev.preventDefault).toBe("function");
    expect(typeof ev.stopPropagation).toBe("function");
    expect(ev.detail).toBe(7);
  });
});
