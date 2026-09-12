import { describe, expect, it } from "@rstest/core";
import m from "mithril";
import shim from "../src/lynx-mithril-shim.js";

// Regression for a real bug found via mithril-lynx-ui's own test suite: a
// component whose view() throws on its FIRST creation (e.g. a fail-loudly
// prop validation error) left that component type permanently unable to
// render at all — not just the one instance that threw, but every later
// mount of the SAME component anywhere, silently producing nothing (no
// render, no error). Root cause: initComponent()'s reentrancy guard stores
// its lock on the component's own shared `view` function object (or the
// tag itself, for class-style components) rather than per-instance, and
// only cleared it on the success path — a thrown view() skipped that reset
// and left the lock stuck at `true` forever.

const shimModule = ((shim as any).default ?? shim) as {
  renderToPage(pageElement: unknown, vnode: unknown): unknown;
};

function mount(view: () => unknown): any {
  lynxTestingEnv.switchToMainThread();
  const page = __CreatePage("0", 0);
  return shimModule.renderToPage(page, m({ view })) as any;
}

describe("initComponent reentrancy lock", () => {
  it("a component whose view() throws on first creation can still render successfully later", () => {
    let shouldThrow = true;
    const Flaky = {
      view() {
        if (shouldThrow) throw new Error("validation failed");
        return m("view", { class: "ok" });
      },
    };

    expect(() => mount(() => m(Flaky))).toThrow(/validation failed/);

    shouldThrow = false;
    const root = mount(() => m(Flaky));

    expect(root.firstChild).not.toBeNull();
    expect(root.firstChild._tag).toBe("view");
  });

  it("class-style components (tag-as-sentinel path) are unlocked the same way", () => {
    let shouldThrow = true;
    function FlakyClass() {
      if (shouldThrow) throw new Error("ctor failed");
    }
    // A prototype `view` (not one assigned in the constructor body) is what
    // makes initComponent call this via `new`, per its own
    // `vnode.tag.prototype.view` check — the actual "class-style" path.
    FlakyClass.prototype.view = () => m("view", { class: "ok" });

    expect(() => mount(() => m(FlakyClass as any))).toThrow(/ctor failed/);

    shouldThrow = false;
    const root = mount(() => m(FlakyClass as any));

    expect(root.firstChild).not.toBeNull();
  });
});
