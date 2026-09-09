import { describe, expect, it } from "@rstest/core";
import m from "mithril";
import shim from "../src/lynx-mithril-shim.js";
import * as rendererBackground from "../renderer/background.js";
import * as rendererMainThread from "../renderer/main-thread.js";

// Full round trip through REAL PAPI replay: background renders against the
// virtual tree, main thread's applyPatch() replays the ops against a real
// LynxNodeWrapper tree, a simulated tap on the REAL node is forwarded back
// to the background thread's virtual node, the app's Mithril handler runs
// and redraws, and the resulting patch updates the REAL tree again.

type Wrapper = {
  _tag: string;
  _handle: any;
  textContent: string;
  firstChild: Wrapper | null;
  nextSibling: Wrapper | null;
};

const shimModule = ((shim as any).default ?? shim) as {
  createPageWrapper(pageElement: unknown): unknown;
};

const storedListeners = (
  node: any,
  type: string,
): Set<(...args: any[]) => unknown> => node.__vanillaListeners?.[type] ?? new Set();

describe("renderer mode end-to-end (real PAPI replay)", () => {
  it("replays the initial patch onto real elements and round-trips a tap through the background thread", () => {
    lynxTestingEnv.switchToMainThread();

    // Same capture technique as test/app.test.ts (mithril-app): patch the
    // PERSISTENT main-thread globalThis snapshot, not the live global, so a
    // mid-call thread switch (none here, but kept for consistency/safety)
    // can't silently revert it.
    let capturedPage: any;
    const mainGlobals = (lynxTestingEnv as any).mainThread.globalThis;
    const originalCreatePage = mainGlobals.__CreatePage;
    mainGlobals.__CreatePage = (...args: unknown[]) => {
      capturedPage = originalCreatePage(...args);
      return capturedPage;
    };
    (globalThis as any).__CreatePage = mainGlobals.__CreatePage;

    rendererMainThread.setupRenderer();

    let count = 0;
    const Counter = {
      view: () =>
        m("view", { class: "page" }, [
          m("view", { class: "button", ontap: () => {
            count += 1;
            rendererBackground.redraw();
          } }, [
            m("text", null, "Tap"),
          ]),
          m("text", { class: "counter" }, String(count)),
        ]),
    };

    lynxTestingEnv.switchToBackgroundThread();
    rendererBackground.renderApp({ root: () => m(Counter) });

    // The background thread's own render ran independently of __RenderPage;
    // now the native engine fires it, which must apply the buffered patch.
    lynxTestingEnv.switchToMainThread();
    lynx.getEngine().dispatchEvent({ type: "__RenderPage", data: [{}] });

    const rootWrapper = shimModule.createPageWrapper(capturedPage) as Wrapper;
    const pageView = rootWrapper.firstChild;
    const button = pageView?.firstChild;
    const counter = button?.nextSibling;

    expect(counter?.textContent).toBe("0");

    // Simulate a real tap on the REAL button: this must forward across the
    // channel to the background thread's virtual node's Mithril handler.
    for (const handler of storedListeners(button?._handle, "tap")) {
      handler({ type: "tap" });
    }

    expect(counter?.textContent).toBe("1");

    // __DestroyLifetime relay tears down both sides.
    lynx.getEngine().dispatchEvent({ type: "__DestroyLifetime", data: [] });
    for (const handler of storedListeners(button?._handle, "tap")) {
      handler({ type: "tap" });
    }
    expect(counter?.textContent).toBe("1");
  });

  it("propagates style REMOVALS through to the real element (not just additions)", () => {
    // This is the exact correctness trap setStyleProps's implementation
    // comment warns about: the real LynxStyleProxy only accumulates/
    // overwrites via setProperty, so replaying via `wrapper.style[key] = v`
    // would leak stale keys forever. applyPatch() instead calls
    // __SetInlineStyles directly with the virtual side's complete, current
    // style object — this asserts that actually holds on a real element.
    lynxTestingEnv.switchToMainThread();
    const mainGlobals = (lynxTestingEnv as any).mainThread.globalThis;
    let capturedPage: any;
    const originalCreatePage = mainGlobals.__CreatePage;
    mainGlobals.__CreatePage = (...args: unknown[]) => {
      capturedPage = originalCreatePage(...args);
      return capturedPage;
    };
    (globalThis as any).__CreatePage = mainGlobals.__CreatePage;

    rendererMainThread.setupRenderer();

    let showColor = true;
    const Box = {
      view: () =>
        m("view", {
          style: showColor ? { backgroundColor: "red", fontSize: "12px" } : { fontSize: "12px" },
        }),
    };

    lynxTestingEnv.switchToBackgroundThread();
    rendererBackground.renderApp({ root: () => m(Box) });

    lynxTestingEnv.switchToMainThread();
    lynx.getEngine().dispatchEvent({ type: "__RenderPage", data: [{}] });

    const rootWrapper = shimModule.createPageWrapper(capturedPage) as Wrapper;
    const box = rootWrapper.firstChild as any;

    const papiCalls = (globalThis as any).__papiCalls as { fn: string; args: unknown[] }[];
    const lastStyleCall = () => papiCalls.filter((c) => c.fn === "__SetInlineStyles").at(-1);

    expect(lastStyleCall()?.args[0]).toBe(box._handle);
    expect(lastStyleCall()?.args[1]).toEqual({ backgroundColor: "red", fontSize: "12px" });

    // Remove backgroundColor entirely (not just change its value).
    lynxTestingEnv.switchToBackgroundThread();
    showColor = false;
    rendererBackground.redraw();

    lynxTestingEnv.switchToMainThread();
    // backgroundColor arrives as "" rather than an absent key — this matches
    // the REAL LynxStyleProxy's exact behavior (verified: it's the same
    // shim/main-thread-owned code path, not something Phase 4 changed):
    // render.js writes non-dash-case style keys via plain property
    // assignment (`element.style[key] = ""`), never through setProperty(),
    // so there's no delete-from-_props path involved — the key just ends up
    // holding "". __SetInlineStyles/CSSOM treat an empty-string value as
    // "clear this property", same practical effect as an absent key.
    expect(lastStyleCall()?.args[1]).toEqual({ backgroundColor: "", fontSize: "12px" });
  });
});
