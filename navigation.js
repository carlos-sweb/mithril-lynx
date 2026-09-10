// navigation.js
//
// Stack-based, in-memory screen navigation (project plan follow-up, "basic
// Activity" template support) — deliberately NOT built on m.route. Real
// `m.route` is hard-wired to the browser's URL/History API (see README.md's
// "Known permanent gaps"), which has no Lynx equivalent: a Lynx page has no
// address bar, no back/forward, nothing URL-addressable. Android's own
// Activity navigation doesn't need URLs either — it's a plain back-stack —
// so this module ports that idea directly instead of forcing a URL-shaped
// abstraction onto an environment that has no URLs.
//
// Only the top of the stack is ever mounted (previous screens are torn
// down, not kept alive offscreen) — matching how most single-activity /
// single-page navigators actually behave, and avoiding the cost of keeping
// arbitrarily many past screens' DOM trees around. A popped screen that
// needs to remember its own state should keep that state somewhere the app
// already owns (a module-level store, background.js's data store, etc.),
// not rely on the screen's own component instance surviving the pop.

import shim from "./src/lynx-mithril-shim.js";
import m from "mithril";

/**
 * Creates a navigator: a stack of {component, attrs} screens, plus a
 * `Navigator` Mithril component that always renders whichever screen is on
 * top. Every screen receives its own `attrs` PLUS a `nav` prop (this
 * navigator's push/pop/replace/canGoBack), so screens don't need to import
 * the navigator instance separately to navigate onward.
 */
export function createNavigator(options) {
	const { initial, initialAttrs } = options;
	if (initial == null) throw new Error("mithril-lynx/navigation: createNavigator() requires an `initial` screen");

	const stack = [{ component: initial, attrs: initialAttrs }];

	function top() {
		return stack[stack.length - 1];
	}

	function push(component, attrs) {
		stack.push({ component, attrs });
		shim.redraw();
	}

	function replace(component, attrs) {
		stack[stack.length - 1] = { component, attrs };
		shim.redraw();
	}

	/** Returns false (a no-op) at the root screen, true otherwise. */
	function pop() {
		if (stack.length <= 1) return false;
		stack.pop();
		shim.redraw();
		return true;
	}

	function canGoBack() {
		return stack.length > 1;
	}

	function depth() {
		return stack.length;
	}

	const nav = { push, pop, replace, canGoBack, depth };

	const Navigator = {
		view() {
			const { component, attrs } = top();
			return m(component, Object.assign({}, attrs, { nav }));
		},
	};

	return Object.assign({ Navigator }, nav);
}
