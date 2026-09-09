import { describe, expect, it } from "@rstest/core";
import shim from "../src/lynx-mithril-shim.js";
import { createGesture, GestureType } from "../gesture.js";

// Project plan, Phase 7: verifies createGesture() calls __SetGestureDetector
// with the exact config/relationMap shape @lynx-js/react's own
// processGesture.js uses (ground truth, not guesswork). Each callback is now
// wrapped as a worklet ctx object (`{_wkltId}`), not passed as a plain
// function — see gesture.js's header comment for why a real device silently
// dropped a plain-function callback, confirmed by reading
// runtime/lib/worklet-runtime/workletRuntime.js.

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

    const args = lastCallOf("__SetGestureDetector")?.args as any[];
    expect(args[0]).toBe(view._handle);
    expect(args[1]).toBe(pan.id);
    expect(args[2]).toBe(GestureType.PAN);
    expect(args[4]).toEqual({ waitFor: [], simultaneous: [], continueWith: [] });

    // Each callback is a worklet ctx object (`{_wkltId}`), NOT the plain
    // function — native's real runWorklet() rejects anything that isn't an
    // object with `_wkltId`/`_lepusWorkletHash` (see gesture.js's header).
    const cbs = args[3].callbacks as { name: string; callback: unknown }[];
    expect(cbs.map((c) => c.name)).toEqual(["onStart", "onEnd"]);
    for (const c of cbs) {
      expect(typeof c.callback).toBe("object");
      expect(c.callback).toHaveProperty("_wkltId");
    }

    void onStart;
    void onEnd;
  });

  it("dispatches through globalThis.runWorklet the same way native does, calling the original function", () => {
    const { view } = setupNode();
    const seen: unknown[] = [];
    createGesture(view, { type: "pan", callbacks: { onUpdate: (e: unknown) => seen.push(e) } });

    const args = lastCallOf("__SetGestureDetector")?.args as any[];
    const updateCb = args[3].callbacks[0].callback;

    expect(typeof (globalThis as any).runWorklet).toBe("function");
    (globalThis as any).runWorklet(updateCb, ["fake-update-event"]);
    expect(seen).toEqual(["fake-update-event"]);

    // A ctx that isn't a registered worklet is dropped silently, matching
    // native's own validateWorklet() behavior — no throw either way.
    expect(() => (globalThis as any).runWorklet({ _wkltId: "not-a-real-id" }, [])).not.toThrow();
    expect(() => (globalThis as any).runWorklet(() => {}, [])).not.toThrow();
  });

  it("passes native's real 2-arg (event, controller) shape through positionally, in order", () => {
    // Real native gesture dispatch calls callbacks as (event, controller) —
    // see gesture.js's header, item 3. jsdom's plain V8 engine can't
    // reproduce the actual on-device failure (Function.prototype.apply()
    // choking on the real native controller object specifically), so this
    // only pins the observable contract: both arguments arrive, in order.
    // worklet-runtime.js's own code comment is what guards against
    // reintroducing fn.apply(ctx, args) there.
    const { view } = setupNode();
    const seenArgs: unknown[][] = [];
    createGesture(view, { type: "pan", callbacks: { onUpdate: (...args: unknown[]) => seenArgs.push(args) } });

    const args = lastCallOf("__SetGestureDetector")?.args as any[];
    const updateCb = args[3].callbacks[0].callback;
    const controllerStandIn = { __SetGestureState() {}, __ConsumeGesture() {} };

    (globalThis as any).runWorklet(updateCb, ["fake-event", controllerStandIn]);

    expect(seenArgs).toEqual([["fake-event", controllerStandIn]]);
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
