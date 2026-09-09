import { describe, expect, it } from "@rstest/core";
import m from "mithril";
import * as background from "../background.js";
import * as mainThread from "../main-thread.js";

// End-to-end test of Phase 3's "data-channel mode": drives both sides of the
// simulated dual-thread environment (@lynx-js/testing-environment routes
// events between mainThreadContexts/backgroundThreadContexts for real) in a
// single scenario, mirroring how setupApp()/setupBackground() are each only
// ever called once in a real app.

describe("mithril-lynx cross-thread data channel", () => {
  it("renders on __RenderPage, redraws on __UpdatePage and background pushes, and relays dispatchToBackground", () => {
    const renderedCounts: unknown[] = [];
    const received: Array<{ handlerName: string; data: unknown }> = [];

    lynxTestingEnv.switchToBackgroundThread();
    background.setBackgroundEventHandler((handlerName, data) => {
      received.push({ handlerName, data: data as unknown });
    });
    background.setupBackground();

    lynxTestingEnv.switchToMainThread();
    const Counter = {
      view: () => {
        const data = mainThread.getData() as { count?: number } | undefined;
        renderedCounts.push(data?.count);
        return m("text", { id: "count" }, String(data?.count ?? "none"));
      },
    };
    mainThread.setupApp({ root: () => m(Counter) });

    // __RenderPage: first paint, no background push registered as data yet.
    lynx.getEngine().dispatchEvent({ type: "__RenderPage", data: [{ count: 1 }] });
    expect(renderedCounts).toEqual([1]);
    expect(mainThread.getData()).toEqual({ count: 1 });

    // __UpdatePage: triggers a Mithril redraw via the shim, not a new root().
    lynx.getEngine().dispatchEvent({ type: "__UpdatePage", data: [{ count: 2 }] });
    expect(renderedCounts).toEqual([1, 2]);

    // Background thread pushes a data change: main thread merges + redraws.
    lynxTestingEnv.switchToBackgroundThread();
    background.setData({ count: 3 });
    expect(renderedCounts).toEqual([1, 2, 3]);
    expect(mainThread.getData()).toEqual({ count: 3 });

    // Main thread dispatches an action to the background's registered handler.
    lynxTestingEnv.switchToMainThread();
    mainThread.dispatchToBackground("ping", { foo: "bar" });
    expect(received).toEqual([{ handlerName: "ping", data: { foo: "bar" } }]);

    // __DestroyLifetime tears down both sides: further pushes are no-ops.
    lynx.getEngine().dispatchEvent({ type: "__DestroyLifetime", data: [] });
    lynxTestingEnv.switchToBackgroundThread();
    background.setData({ count: 999 });
    expect(renderedCounts).toEqual([1, 2, 3]);
  });
});
