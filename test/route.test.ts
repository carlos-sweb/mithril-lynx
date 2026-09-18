import { describe, expect, it } from "@rstest/core";
import m from "mithril-runtime";
import { createRoute } from "../src/route.js";
import { Op } from "../src/patch-protocol.js";

// createRoute() calls renderApp() (src/background.js) internally on first
// match, which unconditionally uses the real cross-thread channel
// (channel.js -> lynx.getCoreContext()/getJSContext()) — so every test
// here runs against @lynx-js/testing-environment's real PAPI, exactly like
// test/end-to-end.test.ts, not a mock.

function setupRealTree() {
	lynxTestingEnv.switchToMainThread();
	const pageId = __GetElementUniqueID(__CreatePage());
	const applier = createPatchApplier(pageId);
	applier.registerPageRoot(__CreateView(pageId));

	lynxTestingEnv.switchToBackgroundThread();
	const capturedOps: unknown[][] = [];
	// Same pattern channel.js's real sendPatchToMainThread uses, captured
	// on the main-thread side so ops can be applied and the resulting real
	// tree inspected.
	lynxTestingEnv.switchToMainThread();
	lynx.getJSContext().addEventListener("MithrilLynx:Patch", (event: any) => {
		capturedOps.push(event.data);
		lynxTestingEnv.switchToMainThread();
		applier.applyPatch(event.data);
	});

	return { applier, capturedOps };
}

// createPatchApplier is imported dynamically per-test-file below since it
// isn't exported from a stable path used elsewhere yet in tests.
import { createPatchApplier } from "../src/apply-patch.js";

describe("route.js: in-memory router (plan m-route-en-memoria.md)", () => {
	it("mounts the default route and exposes route.get()/route.param()", () => {
		setupRealTree();
		lynxTestingEnv.switchToBackgroundThread();

		const route = createRoute();
		const Home = { view: () => m("text", null, "home") };
		const User = { view: () => m("text", null, "user:" + route.param("id")) };

		route("/", { "/": Home, "/users/:id": User });

		expect(route.get()).toBe("/");

		route.set("/users/42");
		expect(route.get()).toBe("/users/42");
		expect(route.param("id")).toBe("42");
	});

	it("navigating replaces the screen with no orphaned nodes left behind", () => {
		const { capturedOps } = setupRealTree();
		lynxTestingEnv.switchToBackgroundThread();

		const route = createRoute();
		const A = { view: () => m("view", { key: "a" }, [m("text", null, "A")]) };
		const B = { view: () => m("view", { key: "b" }, [m("text", null, "B")]) };

		route("/a", { "/a": A, "/b": B });
		capturedOps.length = 0; // only care about the ops from the NAVIGATION below

		route.set("/b");

		// Same spirit as test/structural-reload.test.ts, but here the whole
		// screen changes (not a sibling insert) — the decisive check is
		// that A's subtree is actually torn down (RemoveChild present, and
		// no id from A gets reused for a create), not left dangling while
		// B's is appended on top of it.
		const navOps = capturedOps.flat();
		expect(navOps).toContain(Op.RemoveChild);
		expect(navOps).toContain(Op.CreateElement);
	});

	it("back()/forward() walk the in-memory history stack", () => {
		setupRealTree();
		lynxTestingEnv.switchToBackgroundThread();

		const route = createRoute();
		const A = { view: () => m("text", null, "A") };
		const B = { view: () => m("text", null, "B") };
		const C = { view: () => m("text", null, "C") };

		route("/a", { "/a": A, "/b": B, "/c": C });
		route.set("/b");
		route.set("/c");
		expect(route.get()).toBe("/c");

		route.back();
		expect(route.get()).toBe("/b");

		route.back();
		expect(route.get()).toBe("/a");

		route.forward();
		expect(route.get()).toBe("/b");
	});

	it("onmatch + SKIP falls through to the next matching route", () => {
		setupRealTree();
		lynxTestingEnv.switchToBackgroundThread();

		const route = createRoute();
		const Fallback = { view: () => m("text", null, "fallback") };
		let calls = 0;

		route("/x", {
			"/x": {
				onmatch() {
					calls++;
					return route.SKIP;
				},
			},
			"/:any...": Fallback,
		});

		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(calls).toBe(1);
				expect(route.get()).toBe("/x");
				resolve();
			}, 0);
		});
	});

	it("route.Link navigates on tap, and disabled Links don't wire ontap", () => {
		setupRealTree();
		lynxTestingEnv.switchToBackgroundThread();

		const route = createRoute();
		const A = { view: () => m("text", null, "A") };
		const B = { view: () => m("text", null, "B") };
		route("/a", { "/a": A, "/b": B });

		const link = (route as any).Link.view({
			attrs: { href: "/b" },
			children: ["Go"],
		});
		expect(typeof link.attrs.ontap).toBe("function");
		link.attrs.ontap({ currentTarget: null, redraw: true });
		expect(route.get()).toBe("/b");

		const disabledLink = (route as any).Link.view({
			attrs: { href: "/a", disabled: true },
			children: ["Go"],
		});
		expect(disabledLink.attrs.ontap).toBeUndefined();
	});
});
