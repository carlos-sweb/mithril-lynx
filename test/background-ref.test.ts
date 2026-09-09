import { describe, expect, it } from "@rstest/core";
import { createRef } from "../background.js";

// Project plan, Phase 5: background.js's createRef() is a thin wrapper over
// lynx.createSelectorQuery().select(selector).invoke({...}).exec() — the
// same primitive ReactLynx's own background-thread refs bottom out on. The
// testing environment's own NodesRef.invoke() throws "not implemented", so
// this stubs createSelectorQuery to verify the WIRING (right selector,
// right method/params, success/fail -> resolve/reject) rather than
// re-testing the native bridge itself.

describe("background.js createRef (selector-query bridge)", () => {
  it("resolves with the success callback's data, using the given selector/method/params", async () => {
    lynxTestingEnv.switchToBackgroundThread();
    const calls: unknown[] = [];
    (globalThis as any).lynx.createSelectorQuery = () => ({
      select(selector: string) {
        calls.push({ select: selector });
        return {
          invoke(options: any) {
            calls.push({ invoke: { method: options.method, params: options.params } });
            options.success({ ok: true });
            return { exec: () => calls.push("exec") };
          },
        };
      },
    });

    const ref = createRef("#my-input");
    const result = await ref.invoke("focus", { animated: true });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      { select: "#my-input" },
      { invoke: { method: "focus", params: { animated: true } } },
      "exec",
    ]);
  });

  it("rejects with the fail callback's data", async () => {
    lynxTestingEnv.switchToBackgroundThread();
    (globalThis as any).lynx.createSelectorQuery = () => ({
      select: () => ({
        invoke(options: any) {
          options.fail({ error: "not found" });
          return { exec: () => {} };
        },
      }),
    });

    const ref = createRef("#missing");
    await expect(ref.invoke("focus")).rejects.toEqual({ error: "not found" });
  });
});
