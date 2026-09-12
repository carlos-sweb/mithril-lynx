import { describe, expect, it } from "@rstest/core";
import shim from "../src/lynx-mithril-shim.js";
import { wrapElement } from "../element.js";

// Project plan, Phase 5: element.js is the ergonomic imperative escape
// hatch a Mithril oncreate(vnode) hook would use with vnode.dom. These tests
// exercise it against a real LynxNodeWrapper (via the shim's own
// createPageWrapper), asserting it calls the right PAPI with the right args
// — it's a thin wrapper, not new capability, so this is really testing the
// wiring, not reimplementing PAPI semantics.

const papiCalls = (): { fn: string; args: unknown[] }[] => (globalThis as any).__papiCalls;
const lastCallOf = (fn: string) => papiCalls().filter((c) => c.fn === fn).at(-1);

const shimModule = ((shim as any).default ?? shim) as {
  createPageWrapper(pageElement: unknown): unknown;
};

function setupNode(): { view: any } {
  lynxTestingEnv.switchToMainThread();
  const page = __CreatePage("0", 0);
  const rootWrapper = shimModule.createPageWrapper(page) as any;
  const view = rootWrapper.ownerDocument.createElement("view");
  rootWrapper.appendChild(view);
  return { view };
}

describe("element.js (main-thread ref helpers)", () => {
  it("setStyleProperty/setStyleProperties call __SetInlineStyles", () => {
    const { view } = setupNode();
    const el = wrapElement(view);

    el.setStyleProperty("fontSize", "20px");
    expect(lastCallOf("__SetInlineStyles")?.args).toEqual([view._handle, { fontSize: "20px" }]);

    el.setStyleProperties({ color: "red", fontSize: "12px" });
    expect(lastCallOf("__SetInlineStyles")?.args).toEqual([view._handle, { color: "red", fontSize: "12px" }]);
  });

  it("setAttribute mirrors LynxNodeWrapper's class/id/data/generic special-casing", () => {
    const { view } = setupNode();
    const el = wrapElement(view);

    el.setAttribute("placeholder", "Type here");
    expect(lastCallOf("__SetAttribute")?.args).toEqual([view._handle, "placeholder", "Type here"]);

    el.setAttribute("class", "highlighted");
    expect(lastCallOf("__SetClasses")?.args).toEqual([view._handle, "highlighted"]);

    el.setAttribute("id", "my-view");
    expect(lastCallOf("__SetID")?.args).toEqual([view._handle, "my-view"]);

    el.setAttribute("data-foo", "bar");
    expect(lastCallOf("__AddDataset")?.args).toEqual([view._handle, "foo", "bar"]);
  });

  it("clearing class passes an empty string, never undefined/null", () => {
    // Real hardware's FiberSetClasses rejects a non-string argument outright
    // ("FiberSetClasses param 1 should be String") — confirmed on device via
    // mithril-lynx-ui's FeedList, where a native list-item got recycled
    // between content that has a "class" attr and content that doesn't. The
    // jsdom-backed test mock (ElementPAPI's __SetClasses is just
    // `e.className = cls`) happily accepts undefined, so only an explicit
    // type assertion here — not the mock's own behavior — catches a
    // regression.
    const { view } = setupNode();
    const el = wrapElement(view);

    el.setAttribute("class", "highlighted");
    el.setAttribute("class", null);
    expect(lastCallOf("__SetClasses")?.args).toEqual([view._handle, ""]);
    expect(typeof lastCallOf("__SetClasses")?.args[1]).toBe("string");

    // The two OTHER call sites with the same bug, exercised directly on the
    // real LynxNodeWrapper rather than through element.js's wrapElement:
    // LynxNodeWrapper.prototype.removeAttribute (the path Mithril's own
    // attrs-diffing actually calls when a `class`/`className` attr on an
    // `m("view", {class: ...})` vnode disappears between renders — see
    // render.js's removeAttr, `vnode.dom.removeAttribute("class")`) and the
    // `className` DIRECT_PROPS setter (the `vnode.dom.className = value`
    // path some other call sites use).
    view.setAttribute("class", "highlighted");
    view.removeAttribute("class");
    expect(lastCallOf("__SetClasses")?.args).toEqual([view._handle, ""]);

    (view as any).className = "highlighted";
    (view as any).className = null;
    expect(lastCallOf("__SetClasses")?.args).toEqual([view._handle, ""]);
  });

  it("querySelector/querySelectorAll delegate to __QuerySelector(All) and re-wrap the result", () => {
    const { view } = setupNode();
    const child = view.ownerDocument.createElement("text");
    child.setAttribute("id", "target");
    view.appendChild(child);

    const el = wrapElement(view);
    const found = el.querySelector("#target");
    expect(found).not.toBeNull();
    expect(found?.setAttribute).toBeInstanceOf(Function); // re-wrapped, not a raw handle

    expect(el.querySelector("#missing")).toBeNull();
  });

  it("animate/playAnimation/pauseAnimation/cancelAnimation call __ElementAnimate with the right operation code", () => {
    const { view } = setupNode();
    const el = wrapElement(view);

    el.animate([{ opacity: 1 }], { name: "fade", duration: 200 });
    expect(lastCallOf("__ElementAnimate")?.args).toEqual([
      view._handle,
      [0, "fade", [{ opacity: 1 }], { name: "fade", duration: 200 }],
    ]);

    el.playAnimation("fade");
    expect(lastCallOf("__ElementAnimate")?.args).toEqual([view._handle, [1, "fade"]]);

    el.pauseAnimation("fade");
    expect(lastCallOf("__ElementAnimate")?.args).toEqual([view._handle, [2, "fade"]]);

    el.cancelAnimation("fade");
    expect(lastCallOf("__ElementAnimate")?.args).toEqual([view._handle, [3, "fade"]]);
  });

  it("invoke() wraps __InvokeUIMethod's callback in a Promise", async () => {
    const { view } = setupNode();
    const el = wrapElement(view);

    const result = await el.invoke("focus", { animated: true });
    expect(result).toEqual({ code: 0, data: { method: "focus", params: { animated: true } } });
  });
});
