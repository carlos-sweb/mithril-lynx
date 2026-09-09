import { describe, expect, it } from "@rstest/core";
import shim from "../src/lynx-mithril-shim.js";
import { createGesture, GestureType } from "../gesture.js";

// Project plan, Phase 7: verifies createGesture() calls __SetGestureDetector
// with the exact config/relationMap shape @lynx-js/react's own
// processGesture.js uses (ground truth, not guesswork) — see gesture.js's
// header comment for what's still unverified against a real device (whether
// the callback slot accepts a plain function, as assumed here).

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

describe("gesture.js", () => {
  it("sets has-react-gesture/flatten attrs, then registers the detector via __SetGestureDetector", () => {
    const { view } = setupNode();
    const onStart = () => {};
    const onEnd = () => {};

    const pan = createGesture(view, { type: "pan", callbacks: { onStart, onEnd } });

    expect(lastCallOf("__SetAttribute")?.args).toEqual([view._handle, "flatten", false]);
    const attrCalls = papiCalls().filter((c) => c.fn === "__SetAttribute");
    expect(attrCalls.some((c) => c.args[1] === "has-react-gesture" && c.args[2] === true)).toBe(true);

    expect(lastCallOf("__SetGestureDetector")?.args).toEqual([
      view._handle,
      pan.id,
      GestureType.PAN,
      { callbacks: [{ name: "onStart", callback: onStart }, { name: "onEnd", callback: onEnd }] },
      { waitFor: [], simultaneous: [], continueWith: [] },
    ]);
  });

  it("accepts a numeric GestureType directly, and passes through a config object", () => {
    const { view } = setupNode();
    createGesture(view, { type: GestureType.LONGPRESS, config: { minDuration: 500 } });

    const args = lastCallOf("__SetGestureDetector")?.args as any[];
    expect(args[2]).toBe(GestureType.LONGPRESS);
    expect(args[3].config).toEqual({ minDuration: 500 });
  });

  it("maps waitFor/simultaneousWith/continueWith to the OTHER gestures' ids", () => {
    const { view } = setupNode();
    const tap = createGesture(view, { type: "tap" });
    const longpress = createGesture(view, { type: "longpress" });
    const pan = createGesture(view, {
      type: "pan",
      waitFor: [tap],
      simultaneousWith: [longpress],
      continueWith: [tap, longpress],
    });

    const args = lastCallOf("__SetGestureDetector")?.args as any[];
    expect(args[1]).toBe(pan.id);
    expect(args[4]).toEqual({
      waitFor: [tap.id],
      simultaneous: [longpress.id],
      continueWith: [tap.id, longpress.id],
    });
  });

  it("remove() calls __RemoveGestureDetector; setState() calls __SetGestureState", () => {
    const { view } = setupNode();
    const pan = createGesture(view, { type: "pan" });

    pan.remove();
    expect(lastCallOf("__RemoveGestureDetector")?.args).toEqual([view._handle, pan.id]);

    pan.setState(2);
    expect(lastCallOf("__SetGestureState")?.args).toEqual([view._handle, pan.id, 2]);
  });
});
