// src/route.js
//
// In-memory `m.route`, replacing `window.history`/`popstate` with a plain
// array — the exact same pattern React Router's `MemoryRouter` and Vue
// Router's `createMemoryHistory()` use for Lynx (see
// .omo/plans/m-route-en-memoria.md §1–§3): both official framework
// integrations converge on "history lives in a JS array, not the browser",
// for the same reason we're doing it here — Lynx has no
// `window.location`/History API at all.
//
// Structured to mirror real Mithril's `api/router.js` as closely as
// possible (same variable names/flow for `resolveRoute`/`route.set`'s
// `hasBeenResolved` gate) so porting route-using app code only requires
// swapping the import, not relearning the control flow. The one
// unavoidable signature change: `m.route(root, defaultRoute, routes)`
// loses `root` — there is no DOM node to point it at in this architecture
// (a single `renderApp()` for the app's whole lifetime, plan §3.1) — see
// the plan §5.2 for why that's a deliberate, documented deviation rather
// than a fake DOM node just to keep the arg count.

import m from "mithril-runtime";
import buildPathname from "mithril-runtime/pathname/build.js";
import parsePathname from "mithril-runtime/pathname/parse.js";
import compileTemplate from "mithril-runtime/pathname/compileTemplate.js";
import { renderApp } from "./background.js";

/**
 * Creates an in-memory router with the `m.route` API.
 * @returns {Function & {SKIP: Object, set: Function, get: Function, param: Function, prefix: string, back: Function, forward: Function, Link: Object}} The `route` function.
 */
export function createRoute() {
	var compiled, fallbackRoute;
	var component, attrs, currentPath, currentResolver;
	var lastUpdate = null;
	var ready = false;
	var hasBeenResolved = false;
	var app = null;

	// The in-memory equivalent of the browser's session history: a plain
	// stack of resolved paths. `route.set(path, data, {replace: true})`
	// overwrites the top entry instead of pushing — same semantics as
	// `history.replaceState` vs `history.pushState`, just without a
	// browser underneath it.
	var history = [];
	var historyIndex = -1;

	var RouterRoot = {
		/**
		 * Renders the current route's component, through its resolver's `render` when present.
		 * @returns {*} The vnode to render.
		 */
		view() {
			var vnode = component != null ? m(component, attrs) : null;
			return currentResolver ? currentResolver.render(vnode) : vnode;
		},
	};

	/**
	 * Finds the route matching `path` and renders it, starting the app on the first resolution.
	 * @param {string} path - The path to resolve.
	 * @param {Object|null} data - Extra params merged into the parsed params.
	 * @returns {void}
	 * @throws {Error} If the default route cannot be resolved.
	 */
	function resolveRoute(path, data) {
		var parsed = parsePathname(path);
		if (data) Object.assign(parsed.params, data);

		/**
		 * Logs a failed `onmatch` and navigates to the default route.
		 * @param {*} e - The error to log.
		 * @returns {void}
		 */
		function reject(e) {
			if (typeof console !== "undefined") console.error(e);
			route.set(fallbackRoute, null, { replace: true });
		}

		loop(0);
		/**
		 * Tries each compiled route from `i` onward.
		 * @param {number} i - The index to start from.
		 * @returns {void}
		 */
		function loop(i) {
			for (; i < compiled.length; i++) {
				if (compiled[i].check(parsed)) {
					var payload = compiled[i].payload;
					var update = (lastUpdate = function (comp) {
						if (update !== lastUpdate) return;
						if (comp === route.SKIP) return loop(i + 1);
						component = comp != null && (typeof comp.view === "function" || typeof comp === "function")
							? comp
							: "view";
						attrs = parsed.params;
						currentPath = path;
						lastUpdate = null;
						currentResolver = payload.render ? payload : null;
						if (hasBeenResolved) {
							app.redraw();
						} else {
							hasBeenResolved = true;
							app = renderApp({ root: () => m(RouterRoot) });
						}
					});
					if (payload.view || typeof payload === "function") {
						update(payload);
					} else if (payload.onmatch) {
						Promise.resolve()
							.then(() => payload.onmatch(parsed.params, path, compiled[i].route))
							.then(update, path === fallbackRoute ? undefined : reject);
					} else {
						update("view");
					}
					return;
				}
			}
			if (path === fallbackRoute) {
				throw new Error("Could not resolve default route " + fallbackRoute + ".");
			}
			route.set(fallbackRoute, null, { replace: true });
		}
	}

	/**
	 * @param {string} defaultRoute - Both the fallback for an unmatched path
	 *   AND the screen the app starts on — there is no browser URL to read
	 *   an initial path from, so this is the one path the app always starts at
	 *   (the closest in-memory equivalent of React Router's
	 *   `initialEntries={["/"]}`).
	 * @param {Record<string, unknown>} routes - Same shape as real
	 *   `m.route`: `{ "/path/:param": Component | { onmatch, render } }`.
	 * @returns {void}
	 * @throws {SyntaxError} If a route does not start with `/`.
	 * @throws {ReferenceError} If the default route matches no known route.
	 */
	function route(defaultRoute, routes) {
		compiled = Object.keys(routes).map((r) => {
			if (r[0] !== "/") throw new SyntaxError("Routes must start with a '/'.");
			return { route: r, payload: routes[r], check: compileTemplate(r) };
		});
		fallbackRoute = defaultRoute;
		var defaultData = parsePathname(defaultRoute);
		if (!compiled.some((entry) => entry.check(defaultData))) {
			throw new ReferenceError("Default route doesn't match any known routes.");
		}
		if (!ready) {
			history = [defaultRoute];
			historyIndex = 0;
			ready = true;
			resolveRoute(defaultRoute, null);
		} else {
			// Re-registration (e.g. HMR of the route module): keep the history
			// stack and re-resolve the CURRENT path against the new table —
			// the same thing the documented HMR pattern does by hand with
			// route.set(route.get(), null, {replace: true}). Resolving
			// defaultRoute here instead would silently jump the screen back to
			// the initial route and discard the user's back/forward stack.
			resolveRoute(currentPath != null ? currentPath : defaultRoute, null);
		}
	}

	route.SKIP = {};

	/**
	 * Navigates to a path, pushing (or, with `replace`, overwriting) a history entry.
	 * @param {string} path - The path or template to navigate to.
	 * @param {Object|null} [data] - Params to fill the path template with.
	 * @param {{replace?: boolean}} [options] - Navigation options.
	 * @returns {void}
	 * @throws {Error} If called before `route(defaultRoute, routes)`.
	 */
	route.set = function (path, data, options) {
		if (!ready) {
			throw new Error(
				"[mithril-lynx] route.set() called before route(defaultRoute, routes) — " +
					"the route table does not exist yet, so this navigation would be " +
					"silently dropped. Call route() first.",
			);
		}
		if (lastUpdate != null) {
			options = options || {};
			options.replace = true;
		}
		lastUpdate = null;
		path = buildPathname(path, data);
		if (options && options.replace) {
			history[Math.max(historyIndex, 0)] = path;
		} else {
			history = history.slice(0, historyIndex + 1);
			history.push(path);
			historyIndex = history.length - 1;
		}
		if (ready) resolveRoute(path, null);
	};

	/**
	 * @returns {string|undefined} The current path, or `undefined` before the first resolution.
	 */
	route.get = () => currentPath;

	/**
	 * @param {string} [key] - A param name.
	 * @returns {*} That param's value, or all params when `key` is omitted.
	 */
	route.param = (key) => (attrs && key != null ? attrs[key] : attrs);

	// No URL bar in Lynx — kept as an assignable no-op so app code ported
	// from a real Mithril app that defensively sets `m.route.prefix = ""`
	// doesn't throw. It never affects anything here.
	route.prefix = "";

	/**
	 * `back()`/`forward()` walk the SAME in-memory stack `route.set` writes
	 * to — this is the "no native back button" answer from plan §5.7/F0:
	 * static analysis of the installed Lynx runtime found no hardware/
	 * gesture "back" event exposed to JS (only `onAppEnterBackground`,
	 * which is app-lifecycle, not navigation) — so an app's own explicit
	 * back affordance (a `route.Link`/button calling this) is the only
	 * way back navigation happens. Confirming this holds on a real device
	 * is F4/F5 of the plan, not done yet.
	 * @returns {boolean} `true` when the history moved back, `false` when already at the start.
	 */
	route.back = function () {
		if (historyIndex <= 0) return false;
		historyIndex--;
		resolveRoute(history[historyIndex], null);
		return true;
	};
	/**
	 * Moves one entry forward in the in-memory history.
	 * @returns {boolean} `true` when the history moved forward, `false` when already at the end.
	 */
	route.forward = function () {
		if (historyIndex >= history.length - 1) return false;
		historyIndex++;
		resolveRoute(history[historyIndex], null);
		return true;
	};

	// Lynx has no `<a>`/`onclick` — this renders a tap-driven element
	// instead, the same shape ReactLynx's `useNavigate()+ontap` and Vue
	// Lynx's custom `RouterLink` slot use (plan §1–§2, §5.4).
	route.Link = {
		/**
		 * Renders a tap-driven element that navigates to `href`.
		 * @param {{attrs: {href: string, params?: Object, options?: Object, selector?: string, disabled?: boolean, ontap?: Function}, children: *}} vnode - The Mithril vnode.
		 * @returns {*} The rendered vnode.
		 */
		view(vnode) {
			var a = vnode.attrs;
			var selector = a.selector || "view";
			var rest = {};
			for (var key in a) {
				if (key !== "selector" && key !== "options" && key !== "params" && key !== "href" && key !== "ontap") {
					rest[key] = a[key];
				}
			}
			var disabled = Boolean(a.disabled);
			rest.disabled = disabled;
			if (!disabled) {
				rest.ontap = function (e) {
					var result;
					if (typeof a.ontap === "function") result = a.ontap.call(e.currentTarget, e);
					if (result !== false) {
						e.redraw = false;
						route.set(buildPathname(a.href, a.params), null, a.options);
					}
				};
			}
			return m(selector, rest, vnode.children);
		},
	};

	return route;
}

const route = createRoute();
export default route;
