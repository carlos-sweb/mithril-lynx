import { describe, expect, it } from "@rstest/core";
import shim from "../src/lynx-mithril-shim.js";

// The shim's .d.ts types everything as `unknown`; these are the wrapper
// surface the tests exercise.
type Wrapper = {
  nodeType: number;
  _tag: string;
  _handle: any;
  _isRawText: boolean;
  _text: string | null;
  ownerDocument: any;
  style: any;
  nodeValue: string | null;
  textContent: string;
  firstChild: Wrapper | null;
  nextSibling: Wrapper | null;
  appendChild(child: Wrapper): Wrapper;
  insertBefore(child: Wrapper, ref: Wrapper | null): Wrapper;
};

type PapiCall = { fn: string; args: unknown[] };

const shimModule = ((shim as any).default ?? shim) as {
  createPageWrapper(pageElement: unknown): unknown;
};

const papiCalls = (): PapiCall[] => (globalThis as any).__papiCalls as PapiCall[];
const callsOf = (fn: string): PapiCall[] => papiCalls().filter((c) => c.fn === fn);
const lastCallOf = (fn: string): PapiCall | undefined => callsOf(fn).at(-1);

const setup = (): { page: any; rootWrapper: Wrapper } => {
  lynxTestingEnv.switchToMainThread();
  const page = __CreatePage("0", 0);
  return { page, rootWrapper: shimModule.createPageWrapper(page) as Wrapper };
};

describe("lynx-mithril-shim node operations", () => {
  it("createElement/createTextNode return wrappers with __* side effects", () => {
    const { page, rootWrapper } = setup();
    const doc = rootWrapper.ownerDocument;

    const view = doc.createElement("view") as Wrapper;
    const text = doc.createElement("text") as Wrapper;
    const raw = doc.createTextNode("hello") as Wrapper;

    // Wrapper shape
    expect(view.nodeType).toBe(1);
    expect(view._tag).toBe("view");
    expect(view.ownerDocument).toBe(doc);
    expect(text.nodeType).toBe(1);
    expect(text._tag).toBe("text");
    expect(raw.nodeType).toBe(3);
    expect(raw._isRawText).toBe(true);
    expect(raw.nodeValue).toBe("hello");

    // PAPI side effects (call log)
    const pageId = (page as any).$$uiSign;
    expect(lastCallOf("__CreateView")?.args).toEqual([pageId]);
    expect(lastCallOf("__CreateText")?.args).toEqual([pageId]);
    expect(lastCallOf("__CreateRawText")?.args).toEqual(["hello"]);
  });

  it("camelizes dash-case style keys in __SetInlineStyles", () => {
    const { rootWrapper } = setup();
    const doc = rootWrapper.ownerDocument;
    const view = doc.createElement("view") as Wrapper;

    view.style.setProperty("font-size", "30px");

    const last = lastCallOf("__SetInlineStyles");
    expect(last?.args[0]).toBe(view._handle);
    expect(last?.args[1]).toEqual({ fontSize: "30px" });

    // camelCase direct assignment flows through the same proxy
    view.style.fontSize = "20px";
    expect(lastCallOf("__SetInlineStyles")?.args[1]).toEqual({ fontSize: "20px" });
  });

  it("nodeValue set → __SetAttribute(raw, \"text\", v)", () => {
    const { rootWrapper } = setup();
    const doc = rootWrapper.ownerDocument;
    const raw = doc.createTextNode("hello") as Wrapper;

    raw.nodeValue = "world";

    expect(raw.nodeValue).toBe("world");
    const last = lastCallOf("__SetAttribute");
    expect(last?.args[0]).toBe(raw._handle);
    expect(last?.args[1]).toBe("text");
    expect(last?.args[2]).toBe("world");
  });

  it("appendChild/insertBefore preserve ordering", () => {
    const { rootWrapper } = setup();
    const doc = rootWrapper.ownerDocument;
    const parent = doc.createElement("view") as Wrapper;
    const a = doc.createElement("text") as Wrapper;
    const b = doc.createElement("text") as Wrapper;
    const c = doc.createElement("text") as Wrapper;

    parent.appendChild(a);
    parent.appendChild(b);
    parent.insertBefore(c, b);

    // PAPI call order
    expect(callsOf("__AppendElement").map((call) => call.args[1])).toEqual([
      a._handle,
      b._handle,
    ]);
    expect(callsOf("__InsertElementBefore").at(-1)?.args).toEqual([
      parent._handle,
      c._handle,
      b._handle,
    ]);

    // Real DOM order
    expect(Array.from(parent._handle.childNodes)).toEqual([
      a._handle,
      c._handle,
      b._handle,
    ]);

    // insertBefore(child, null) falls back to append
    parent.insertBefore(c, null);
    expect(callsOf("__AppendElement").at(-1)?.args[1]).toBe(c._handle);
  });
});
