import { describe, expect, it } from "@rstest/core";
import * as background from "../background.js";
import * as mainThread from "../main-thread.js";

// Project plan, Phase 6: the worklet substitute's genuinely-cross-thread
// case — background calling a main-thread-registered handler, and vice
// versa, with call/return correlation (the piece the vanilla example's
// fire-and-forget dispatchToBackground/setBackgroundEventHandler doesn't
// need, since it never returns a value). Both directions exercised in one
// scenario, mirroring how registerHandler() is only ever called once per
// key in a real app.

describe("cross-thread function registry (Phase 6)", () => {
  it("background.runOnMainThread resolves with the handler's return value", async () => {
    lynxTestingEnv.switchToMainThread();
    mainThread.registerHandler("double", (n: number) => n * 2);

    lynxTestingEnv.switchToBackgroundThread();
    const result = await background.runOnMainThread("double", 21);
    expect(result).toBe(42);
  });

  it("background.runOnMainThread rejects if the handler throws", async () => {
    lynxTestingEnv.switchToMainThread();
    mainThread.registerHandler("boom", () => {
      throw new Error("kaboom");
    });

    lynxTestingEnv.switchToBackgroundThread();
    await expect(background.runOnMainThread("boom")).rejects.toThrow("kaboom");
  });

  it("main-thread.runOnBackground resolves with the handler's return value", async () => {
    lynxTestingEnv.switchToBackgroundThread();
    background.registerHandler("greet", (name: string) => `hello, ${name}`);

    lynxTestingEnv.switchToMainThread();
    const result = await mainThread.runOnBackground("greet", "world");
    expect(result).toBe("hello, world");
  });

  it("calling an unregistered key resolves with undefined rather than hanging", async () => {
    lynxTestingEnv.switchToBackgroundThread();
    const result = await background.runOnMainThread("never-registered");
    expect(result).toBeUndefined();
  });
});
