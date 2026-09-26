// src/route.js
//
// In-memory `m.route`, replacing `window.history`/`popstate` with a plain
// array — the same pattern ReactLynx's documented routers use (React
// Router's `MemoryRouter`, TanStack Router's `createMemoryHistory()`):
// Lynx has no `window.location`/History API, so history lives in a JS array.
//
// Structured to mirror real Mithril's `api/router.js` (2.3.8) as closely as
// possible — same resolution flow (`resolveRoute`/`loop`/`lastUpdate`),
// resolution deferred after `route.set()` like upstream's `fireAsync`, the
// matched component wrapped in a keyed fragment, `options.state` merged into
// params, and `route.Link` censoring lifecycle hooks — so porting route-using
// app code only requires swapping the import. See ROUTE_CONTRACT_ANALYSIS.md
// for the full parity table. Deliberate differences: no `root` argument (one
// `renderApp()` for the app's whole lifetime), a required `defaultRoute`
// (there is no URL to start from), `back()`/`forward()`/`canGoBack()`, and
// the opt-in Android back button bridge `listenBackButton()`.

import m from "mithril-runtime";
import buildPathname from "mithril-runtime/pathname/build.js";
import parsePathname from "mithril-runtime/pathname/parse.js";
import compileTemplate from "mithril-runtime/pathname/compileTemplate.js";
import censor from "mithril-runtime/util/censor.js";
import decodeURIComponentSafe from "mithril-runtime/util/decodeURIComponentSafe.js";
import { renderApp } from "./background.js";

/** Default global event name for {@link createRoute}'s `listenBackButton`. */
export const BACK_EVENT_NAME = "mithrilLynx:back";

/**
 * Creates an in-memory router with the `m.route` API.
 * @returns {Function & {SKIP: Object, set: Function, get: Function, param: Function, prefix: string, back: Function, forward: Function, canGoBack: Function, listenBackButton: Function, Link: Object}} The `route` function.
 */
export function createRoute() {
	var compiled, fallbackRoute;
	var component, attrs, currentPath, currentResolver;
	var lastUpdate = null;
	var ready = false;
	var hasBeenResolved = false;
	var scheduled = false;
	var app = null;

	// The in-memory equivalent of the browser's session history: one
	// `{ path, state }` entry per navigation. `route.set(path, data,
	// {replace: true})` overwrites the current entry instead of pushing —
	// same semantics as `history.replaceState` vs `history.pushState`.
	var history = [];
	var historyIndex = -1;

	// listenBackButton() subscribers, told whenever canGoBack() changes.
	var backWatchers = new Set();

	var RouterRoot = {
		/**
		 * Renders the current route's component, through its resolver's
		 * `render` when present. Like upstream, the component is wrapped in a
		 * fragment so its `key` (a `:key` route param) is honored: a new key
		 * remounts the page.
		 * @returns {*} The vnode(s) to render.
		 */
		view() {
			var vnode = m(component, attrs);
			if (currentResolver) return currentResolver.render(vnode);
			return [vnode];
		},
	};

	/**
	 * Finds the route matching `path` and renders it, starting the app on the first resolution.
	 * @param {string} path - The path to resolve (as stored in history: encoded).
	 * @param {Object|null} state - The entry's state, merged into the parsed params.
	 * @returns {void}
	 * @throws {Error} If the default route cannot be resolved.
	 */
	function resolveRoute(path, state) {
		var parsed = parsePathname(path);
		if (state) Object.assign(parsed.params, state);

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
						currentPath = decodeURIComponentSafe(path);
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
	 * Resolves the current history entry on the next microtask, once — like
	 * upstream's `fireAsync`. Several navigations in one tick resolve only
	 * the last one, and a navigation started during a render (a redirect in
	 * a page's `oninit`) runs after that render instead of re-entering it.
	 * @returns {void}
	 */
	function scheduleResolve() {
		if (scheduled) return;
		scheduled = true;
		Promise.resolve().then(() => {
			scheduled = false;
			var entry = history[historyIndex];
			resolveRoute(entry.path, entry.state);
		});
	}

	/**
	 * Tells every listenBackButton() subscriber the current canGoBack()
	 * value, if it changed for them. A throwing callback (e.g. a missing
	 * native module) is logged and never breaks navigation.
	 * @returns {void}
	 */
	function notifyBackWatchers() {
		var can = route.canGoBack();
		for (var watcher of backWatchers) {
			if (watcher.last === can) continue;
			watcher.last = can;
			try {
				watcher.onChange(can);
			} catch (e) {
				if (typeof console !== "undefined") console.error("[mithril-lynx] route: onCanGoBackChange threw:", e);
			}
		}
	}

	/**
	 * @param {string} defaultRoute - Both the fallback for an unmatched path
	 *   AND the screen the app starts on — there is no browser URL to read
	 *   an initial path from, so this is the one path the app always starts at
	 *   (the closest in-memory equivalent of React Router's
	 *   `initialEntries={["/"]}`). Required, unlike upstream.
	 * @param {Record<string, unknown>} routes - Same shape as real
	 *   `m.route`: `{ "/path/:param": Component | { onmatch, render } }`.
	 * @returns {void}
	 * @throws {TypeError} If `defaultRoute` is missing.
	 * @throws {SyntaxError} If a route does not start with `/`, or has two params not separated by `/`, `.` or `-`.
	 * @throws {ReferenceError} If the default route matches no known route.
	 */
	function route(defaultRoute, routes) {
		if (typeof defaultRoute !== "string") {
			throw new TypeError(
				"[mithril-lynx] route(defaultRoute, routes): defaultRoute is required — Lynx has no URL to start from.",
			);
		}
		compiled = Object.keys(routes).map((r) => {
			if (r[0] !== "/") throw new SyntaxError("Routes must start with a '/'.");
			if (/:([^\/\.-]+)(\.{3})?:/.test(r)) {
				throw new SyntaxError("Route parameter names must be separated with either '/', '.', or '-'.");
			}
			return { route: r, payload: routes[r], check: compileTemplate(r) };
		});
		fallbackRoute = defaultRoute;
		var defaultData = parsePathname(defaultRoute);
		if (!compiled.some((entry) => entry.check(defaultData))) {
			throw new ReferenceError("Default route doesn't match any known routes.");
		}
		if (!ready) {
			history = [{ path: defaultRoute, state: null }];
			historyIndex = 0;
			ready = true;
			resolveRoute(defaultRoute, null);
			notifyBackWatchers();
		} else {
			// Re-registration (e.g. HMR of the route module): keep the history
			// stack and re-resolve the CURRENT entry against the new table —
			// the same thing the documented HMR pattern does by hand with
			// route.set(route.get(), null, {replace: true}). Resolving
			// defaultRoute here instead would silently jump the screen back to
			// the initial route and discard the user's back/forward stack.
			var entry = history[historyIndex];
			resolveRoute(entry.path, entry.state);
		}
	}

	route.SKIP = {};

	/**
	 * Navigates to a path, pushing (or, with `replace`, overwriting) a
	 * history entry. The history changes right away; the new screen is
	 * resolved on the next microtask, like upstream — so `route.get()` still
	 * returns the previous path until then.
	 * @param {string} path - The path or template to navigate to.
	 * @param {Object|null} [data] - Params to fill the path template with (extra keys become the query string).
	 * @param {{replace?: boolean, state?: Object, title?: string}} [options] - Navigation options. `state` is merged into the route's params and restored by back()/forward(); `title` is accepted and ignored.
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
		var entry = { path: buildPathname(path, data), state: (options && options.state) || null };
		if (options && options.replace) {
			history[Math.max(historyIndex, 0)] = entry;
		} else {
			history = history.slice(0, historyIndex + 1);
			history.push(entry);
			historyIndex = history.length - 1;
		}
		scheduleResolve();
		notifyBackWatchers();
	};

	/**
	 * @returns {string|undefined} The current (decoded) path, or `undefined` before the first resolution.
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
	 * Moves one entry back in the in-memory history. Not part of `m.route`:
	 * there is no browser back button — wire an in-app back affordance to
	 * this, and the Android back button through listenBackButton().
	 * @returns {boolean} `true` when the history moved back, `false` when already at the start.
	 */
	route.back = function () {
		if (historyIndex <= 0) return false;
		historyIndex--;
		scheduleResolve();
		notifyBackWatchers();
		return true;
	};
	/**
	 * Moves one entry forward in the in-memory history.
	 * @returns {boolean} `true` when the history moved forward, `false` when already at the end.
	 */
	route.forward = function () {
		if (historyIndex >= history.length - 1) return false;
		historyIndex++;
		scheduleResolve();
		notifyBackWatchers();
		return true;
	};

	/**
	 * @returns {boolean} Whether back() would navigate (there is an earlier entry).
	 */
	route.canGoBack = () => historyIndex > 0;

	/**
	 * Opt-in bridge for the Android back button. The host sends a global
	 * event (`LynxView.sendGlobalEvent(eventName, ...)`) when back is pressed
	 * and its OnBackPressedCallback is enabled; this calls `route.back()`.
	 * `onCanGoBackChange` is called with the current canGoBack() right away
	 * and whenever it changes, so the host can enable its callback only while
	 * there is history — with none, Android's default (closing the app)
	 * applies. Nothing here blocks: without a host that sends the event, or
	 * without GlobalEventEmitter, it does nothing. See ROUTE.md for the
	 * Android host side.
	 * @param {{eventName?: string, onCanGoBackChange?: (canGoBack: boolean) => void}} [options] - The global event name (default `"mithrilLynx:back"`) and the host notification callback.
	 * @returns {() => void} Stops listening.
	 */
	route.listenBackButton = function (options) {
		var eventName = (options && options.eventName) || BACK_EVENT_NAME;
		var onChange = options && options.onCanGoBackChange;
		var emitter = null;
		try {
			emitter = typeof lynx !== "undefined" && typeof lynx.getJSModule === "function" ? lynx.getJSModule("GlobalEventEmitter") : null;
		} catch (e) {
			emitter = null;
		}
		if (emitter == null || typeof emitter.addListener !== "function") {
			if (typeof console !== "undefined") {
				console.warn("[mithril-lynx] route.listenBackButton(): GlobalEventEmitter is not available — back button events will not be received.");
			}
		}
		var onBack = () => {
			route.back();
		};
		if (emitter != null && typeof emitter.addListener === "function") emitter.addListener(eventName, onBack);
		var watcher = null;
		if (typeof onChange === "function") {
			watcher = { onChange, last: undefined };
			backWatchers.add(watcher);
			if (ready) notifyBackWatchers();
		}
		return function stop() {
			if (emitter != null && typeof emitter.removeListener === "function") emitter.removeListener(eventName, onBack);
			if (watcher != null) backWatchers.delete(watcher);
		};
	};

	// Lynx has no `<a>`/`onclick` — this renders a tap-driven element
	// instead, the same shape ReactLynx's `useNavigate()+bindtap` pattern uses.
	route.Link = {
		/**
		 * Renders a tap-driven element that navigates to `href`. Like
		 * upstream, `key` and lifecycle hooks stay on the Link component and
		 * are not copied onto the rendered element (they would run twice).
		 * @param {{attrs: {href: string, params?: Object, options?: Object, selector?: string, disabled?: boolean, ontap?: Function|{handleEvent: Function}}, children: *}} vnode - The Mithril vnode.
		 * @returns {*} The rendered vnode.
		 */
		view(vnode) {
			var a = vnode.attrs;
			var rest = censor(a, ["selector", "options", "params", "href", "ontap"]);
			var disabled = Boolean(a.disabled);
			rest.disabled = disabled;
			if (!disabled) {
				var ontap = a.ontap;
				var href = buildPathname(a.href, a.params);
				var options = a.options;
				rest.ontap = function (e) {
					var result;
					if (typeof ontap === "function") result = ontap.call(e.currentTarget, e);
					else if (ontap != null && typeof ontap === "object" && typeof ontap.handleEvent === "function") ontap.handleEvent(e);
					if (result !== false && !e.defaultPrevented) {
						e.redraw = false;
						route.set(href, null, options);
					}
				};
			}
			return m(a.selector || "view", rest, vnode.children);
		},
	};

	return route;
}

const route = createRoute();
export default route;
