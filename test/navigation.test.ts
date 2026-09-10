import { describe, expect, it } from "@rstest/core";
import m from "mithril";
import shim from "../src/lynx-mithril-shim.js";
import { createNavigator } from "../navigation.js";

// Stack-based, in-memory navigation (see navigation.js's header comment for
// why this deliberately isn't built on m.route). Tested the same way as any
// other main-thread-owned mithril-lynx render: shim.renderToPage() against
// a real page wrapper from the testing environment's PAPI polyfill.

const shimModule = ((shim as any).default ?? shim) as {
  createPageWrapper(pageElement: unknown): unknown;
  renderToPage(pageElement: unknown, vnode: unknown): unknown;
};

const Home = { view: (vnode: any) => m("text", { id: "home" }, "home:" + JSON.stringify(vnode.attrs.greeting ?? null)) };
const Details = { view: (vnode: any) => m("text", { id: "details" }, "details:" + (vnode.attrs.id ?? "")) };

describe("navigation.js", () => {
  it("renders only the initial screen, with initialAttrs, at depth 1", () => {
    lynxTestingEnv.switchToMainThread();
    const page = __CreatePage("0", 0);
    const nav = createNavigator({ initial: Home, initialAttrs: { greeting: "hi" } });
    const rootWrapper = shimModule.renderToPage(page, m(nav.Navigator)) as any;

    expect(nav.depth()).toBe(1);
    expect(nav.canGoBack()).toBe(false);
    expect(rootWrapper.firstChild.textContent).toBe('home:"hi"');
  });

  it("push() mounts the new screen and injects a nav prop; pop() returns to the previous one", () => {
    lynxTestingEnv.switchToMainThread();
    const page = __CreatePage("0", 0);
    const nav = createNavigator({ initial: Home });
    const rootWrapper = shimModule.renderToPage(page, m(nav.Navigator)) as any;

    nav.push(Details, { id: "42" });
    expect(nav.depth()).toBe(2);
    expect(nav.canGoBack()).toBe(true);
    expect(rootWrapper.firstChild.textContent).toBe("details:42");

    const popped = nav.pop();
    expect(popped).toBe(true);
    expect(nav.depth()).toBe(1);
    expect(rootWrapper.firstChild.textContent).toBe("home:null");
  });

  it("pop() at the root screen is a no-op and returns false", () => {
    lynxTestingEnv.switchToMainThread();
    const page = __CreatePage("0", 0);
    const nav = createNavigator({ initial: Home });
    shimModule.renderToPage(page, m(nav.Navigator));

    expect(nav.pop()).toBe(false);
    expect(nav.depth()).toBe(1);
  });

  it("replace() swaps the top screen without growing the stack", () => {
    lynxTestingEnv.switchToMainThread();
    const page = __CreatePage("0", 0);
    const nav = createNavigator({ initial: Home });
    const rootWrapper = shimModule.renderToPage(page, m(nav.Navigator)) as any;

    nav.push(Details, { id: "1" });
    expect(nav.depth()).toBe(2);

    nav.replace(Details, { id: "2" });
    expect(nav.depth()).toBe(2);
    expect(rootWrapper.firstChild.textContent).toBe("details:2");
  });

  it("each screen receives a nav prop it can use to navigate onward from an event handler", () => {
    lynxTestingEnv.switchToMainThread();
    const page = __CreatePage("0", 0);

    const HomeWithNav = {
      view: (vnode: any) => m("text", {
        id: "home",
        ontap: () => vnode.attrs.nav.push(Details, { id: "from-home" }),
      }, "home"),
    };
    const nav = createNavigator({ initial: HomeWithNav });
    const rootWrapper = shimModule.renderToPage(page, m(nav.Navigator)) as any;

    const homeText = rootWrapper.firstChild;
    for (const handler of homeText._handle.__vanillaListeners?.tap ?? []) handler({ type: "tap" });

    expect(rootWrapper.firstChild.textContent).toBe("details:from-home");
  });
});
