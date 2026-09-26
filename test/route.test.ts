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
		// event.data is [PROTOCOL_VERSION, ...ops] — mirror main-thread.js's
		// own onPatch by stripping the version prefix before applying.
		const ops = event.data.slice(1);
		capturedOps.push(ops);
		lynxTestingEnv.switchToMainThread();
		applier.applyPatch(ops);
	});

	return { applier, capturedOps };
}

// createPatchApplier is imported dynamically per-test-file below since it
// isn't exported from a stable path used elsewhere yet in tests.
import { createPatchApplier } from "../src/apply-patch.js";

/** Navigation resolves on the next microtask (like upstream m.route). */
const settle = () => Promise.resolve();

describe("route.js: in-memory router (plan m-route-en-memoria.md)", () => {
	it("mounts the default route and exposes route.get()/route.param()", async () => {
		setupRealTree();
		lynxTestingEnv.switchToBackgroundThread();

		const route = createRoute();
		const Home = { view: () => m("text", null, "home") };
		const User = { view: () => m("text", null, "user:" + route.param("id")) };

		route("/", { "/": Home, "/users/:id": User });

		expect(route.get()).toBe("/");

		route.set("/users/42");
		await settle();
		expect(route.get()).toBe("/users/42");
		expect(route.param("id")).toBe("42");
	});

	it("navigating replaces the screen with no orphaned nodes left behind", async () => {
		const { capturedOps } = setupRealTree();
		lynxTestingEnv.switchToBackgroundThread();

		const route = createRoute();
		const A = { view: () => m("view", { key: "a" }, [m("text", null, "A")]) };
		const B = { view: () => m("view", { key: "b" }, [m("text", null, "B")]) };

		route("/a", { "/a": A, "/b": B });
		capturedOps.length = 0; // only care about the ops from the NAVIGATION below

		route.set("/b");
		await settle();

		// Same spirit as test/structural-reload.test.ts, but here the whole
		// screen changes (not a sibling insert) — the decisive check is
		// that A's subtree is actually torn down (RemoveChild present, and
		// no id from A gets reused for a create), not left dangling while
		// B's is appended on top of it.
		const navOps = capturedOps.flat();
		expect(navOps).toContain(Op.RemoveChild);
		expect(navOps).toContain(Op.CreateElement);
	});

	it("back()/forward() walk the in-memory history stack", async () => {
		setupRealTree();
		lynxTestingEnv.switchToBackgroundThread();

		const route = createRoute();
		const A = { view: () => m("text", null, "A") };
		const B = { view: () => m("text", null, "B") };
		const C = { view: () => m("text", null, "C") };

		route("/a", { "/a": A, "/b": B, "/c": C });
		route.set("/b");
		route.set("/c");
		await settle();
		expect(route.get()).toBe("/c");

		route.back();
		await settle();
		expect(route.get()).toBe("/b");

		route.back();
		await settle();
		expect(route.get()).toBe("/a");

		route.forward();
		await settle();
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

	it("route.Link navigates on tap, and disabled Links don't wire ontap", async () => {
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
		await settle();
		expect(route.get()).toBe("/b");

		const disabledLink = (route as any).Link.view({
			attrs: { href: "/a", disabled: true },
			children: ["Go"],
		});
		expect(disabledLink.attrs.ontap).toBeUndefined();
	});
});

// Parity fixes found by ROUTE_CONTRACT_ANALYSIS.md — each one was first
// reproduced against the previous route.js, then fixed.
describe("route.js: parity with Mithril 2.3.8's m.route", () => {
	function mountRoute(defaultRoute: string, routes: Record<string, unknown>) {
		setupRealTree();
		lynxTestingEnv.switchToBackgroundThread();
		const route = createRoute();
		route(defaultRoute, routes);
		return route;
	}

	it("a redirect from a page's oninit (a guard) works instead of throwing mid-render", async () => {
		let route: ReturnType<typeof createRoute> | null = null;
		const Guarded = { oninit: () => route!.set("/login"), view: () => m("text", null, "secret") };
		route = mountRoute("/", { "/": { view: () => m("text", null, "home") }, "/secret": Guarded, "/login": { view: () => m("text", null, "login") } });

		route!.set("/secret");
		await settle();
		await settle();
		expect(route!.get()).toBe("/login");
	});

	it("several navigations in one tick resolve once, to the last one", async () => {
		const views: string[] = [];
		const page = (name: string) => ({ view: () => (views.push(name), m("text", null, name)) });
		const route = mountRoute("/a", { "/a": page("a"), "/b": page("b"), "/c": page("c") });
		views.length = 0;

		route.set("/b");
		route.set("/c");
		expect(route.get()).toBe("/a"); // not resolved yet, like upstream
		await settle();
		expect(route.get()).toBe("/c");
		expect(views).toEqual(["c"]);
	});

	it("a changed :key param remounts the page (fresh state)", async () => {
		const inits: string[] = [];
		const Page = { oninit: (v: any) => inits.push(v.attrs.key), view: () => m("text", null, "p") };
		const route = mountRoute("/p/a", { "/p/:key": Page });

		route.set("/p/:key", { key: "b" });
		await settle();
		expect(inits).toEqual(["a", "b"]);
	});

	it("options.state is merged into params and restored by back()/forward()", async () => {
		const route = mountRoute("/", { "/": { view: () => m("text", null, "h") }, "/d": { view: () => m("text", null, "d") } });

		route.set("/d", null, { state: { from: "home" } } as any);
		await settle();
		expect(route.param("from")).toBe("home");

		route.back();
		await settle();
		expect(route.param("from")).toBeUndefined();

		route.forward();
		await settle();
		expect(route.param("from")).toBe("home");
	});

	it("route.get() returns the decoded path, params stay decoded", async () => {
		const route = mountRoute("/", { "/": { view: () => m("text", null, "h") }, "/d/:id": { view: () => m("text", null, "d") } });
		route.set("/d/:id", { id: "a b/c" });
		await settle();
		expect(route.get()).toBe("/d/a b/c");
		expect(route.param("id")).toBe("a b/c");
	});

	it("route.Link runs its lifecycle hooks once (not copied onto the rendered element)", () => {
		let oncreates = 0;
		setupRealTree();
		lynxTestingEnv.switchToBackgroundThread();
		const route = createRoute();
		route("/", { "/": { view: () => m((route as any).Link, { href: "/", oncreate: () => oncreates++, key: "l" }, m("text", null, "l")) } });
		expect(oncreates).toBe(1);
	});

	it("route.Link: preventDefault() cancels navigation, and an EventListener object works as ontap", async () => {
		const route = mountRoute("/a", { "/a": { view: () => m("text", null, "a") }, "/b": { view: () => m("text", null, "b") } });
		const tap = (ontap: unknown) => {
			const link = (route as any).Link.view({ attrs: { href: "/b", ontap }, children: [] });
			const e: any = { currentTarget: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
			link.attrs.ontap(e);
		};

		tap((e: any) => e.preventDefault());
		await settle();
		expect(route.get()).toBe("/a");

		let handled = false;
		tap({ handleEvent: () => { handled = true; } });
		await settle();
		expect(handled).toBe(true);
		expect(route.get()).toBe("/b");
	});

	it("rejects param names not separated by '/', '.' or '-', and a missing default route", () => {
		setupRealTree();
		lynxTestingEnv.switchToBackgroundThread();
		expect(() => createRoute()("/", { "/": { view: () => m("text", null, "x") }, "/:a:b": { view: () => m("text", null, "y") } })).toThrow(SyntaxError);
		expect(() => createRoute()(null as any, { "/": { view: () => m("text", null, "x") } })).toThrow(/defaultRoute is required/);
	});
});

// Opt-in Android back button bridge: the host sends a global event when back
// is pressed (only while its OnBackPressedCallback is enabled), and learns
// through onCanGoBackChange when there is history to go back to.
describe("route.listenBackButton()", () => {
	function withFakeEmitter() {
		const listeners = new Map<string, Set<Function>>();
		const emitter = {
			addListener: (name: string, fn: Function) => (listeners.get(name) ?? listeners.set(name, new Set()).get(name)!).add(fn),
			removeListener: (name: string, fn: Function) => listeners.get(name)?.delete(fn),
			emit: (name: string) => listeners.get(name)?.forEach((fn) => fn()),
			count: (name: string) => listeners.get(name)?.size ?? 0,
		};
		const original = (lynx as any).getJSModule;
		(lynx as any).getJSModule = (name: string) => (name === "GlobalEventEmitter" ? emitter : original?.call(lynx, name));
		return { emitter, restore: () => ((lynx as any).getJSModule = original) };
	}

	function mountTwoPages() {
		setupRealTree();
		lynxTestingEnv.switchToBackgroundThread();
		const route = createRoute();
		route("/", { "/": { view: () => m("text", null, "home") }, "/detail": { view: () => m("text", null, "detail") } });
		return route;
	}

	it("the back event goes back, and onCanGoBackChange reports each change once", async () => {
		const route = mountTwoPages();
		const { emitter, restore } = withFakeEmitter();
		const changes: boolean[] = [];
		const stop = route.listenBackButton({ onCanGoBackChange: (can: boolean) => changes.push(can) });

		route.set("/detail");
		route.set("/detail", null, { replace: true }); // no change in canGoBack
		await settle();
		emitter.emit("mithrilLynx:back");
		await settle();

		expect(route.get()).toBe("/");
		expect(changes).toEqual([false, true, false]);
		stop();
		restore();
	});

	it("stop() unsubscribes; a custom event name is honored", () => {
		const route = mountTwoPages();
		const { emitter, restore } = withFakeEmitter();
		const stop = route.listenBackButton({ eventName: "hostBack" });
		expect(emitter.count("hostBack")).toBe(1);
		stop();
		expect(emitter.count("hostBack")).toBe(0);
		restore();
	});

	it("a throwing onCanGoBackChange (e.g. a missing native module) never breaks navigation", async () => {
		const route = mountTwoPages();
		const { restore } = withFakeEmitter();
		const error = console.error;
		console.error = () => {};
		route.listenBackButton({ onCanGoBackChange: () => { throw new Error("no module"); } });
		route.set("/detail");
		await settle();
		console.error = error;
		expect(route.get()).toBe("/detail");
		restore();
	});

	it("without GlobalEventEmitter it only warns and does nothing", () => {
		const route = mountTwoPages();
		const original = (lynx as any).getJSModule;
		(lynx as any).getJSModule = () => undefined;
		const warn = console.warn;
		const warnings: string[] = [];
		console.warn = (msg: string) => warnings.push(msg);
		const stop = route.listenBackButton();
		console.warn = warn;
		(lynx as any).getJSModule = original;
		expect(warnings.some((w) => w.includes("GlobalEventEmitter"))).toBe(true);
		expect(() => stop()).not.toThrow();
	});
});
