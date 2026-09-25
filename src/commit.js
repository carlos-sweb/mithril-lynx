// src/commit.js
//
// The single, explicit, non-conditional flush contract — this is the actual
// fix for the regression that motivated the whole rewrite (see
// mithril-lynx-v2-desde-cero.md §3.4 and mithril-lynx/AGENTS.md's "Estado
// actual" section for the old implementation's postmortem).
//
// The old bug in one sentence: whether a redraw actually reached the main
// thread depended on `typeof globalThis.__FlushElementTree === "function"`
// — a question whose answer depended on thread/test/mode ordering. That is
// a race condition baked into the architecture, not an edge case to patch.
//
// The rule here: there is exactly one commit callback for the lifetime of
// one `renderApp()` call (see background.js). It is installed explicitly,
// once, by the code that owns the render — never discovered implicitly by
// whoever happens to ask first. Asking to commit before installing one is a
// programmer error and throws immediately and loudly, on the same tick,
// with a message that says exactly what's missing — never a silently
// frozen screen (which is what the old implementation did instead).

const NOT_MOUNTED = Symbol("mithril-lynx:not-mounted");

/**
 * Creates the single-use commit controller for one `renderApp()` call.
 * @returns {{install: (fn: () => void) => void, commit: () => void}} The controller.
 */
export function createCommitController() {
	let commitFn = NOT_MOUNTED;

	return {
		/**
		 * Registers the one and only commit callback. Called exactly once by
		 * `renderApp()` (background.js), before Mithril's `render()` is ever
		 * invoked — so nothing can observe the "not mounted yet" state from
		 * inside a redraw.
		 * @param {() => void} fn - The commit callback.
		 * @returns {void}
		 * @throws {Error} If a commit callback was already installed.
		 */
		install(fn) {
			if (commitFn !== NOT_MOUNTED) {
				throw new Error(
					"[mithril-lynx] commit callback already installed. " +
						"A shim instance is single-use: one renderApp() call, one " +
						"commit callback, for the lifetime of that background " +
						"context. If you're re-mounting for a reload, create a new " +
						"commit controller instead of reusing this one.",
				);
			}
			commitFn = fn;
		},
		/**
		 * The ONLY path anything (an event, `m.redraw()`, an HMR apply) uses
		 * to signal "a render pass just happened, push it". Passed as the
		 * `redraw` argument to every call of Mithril's real `render()` — see
		 * background.js. Mithril's own `EventDict.handleEvent` (render.js,
		 * documented in CONTRACT.md §e) already calls this automatically
		 * after any event handler runs, with no cooperation required from
		 * app code — that automatic call is what makes redraw "just work"
		 * like it does in React/Preact.
		 * @returns {void}
		 * @throws {Error} If called before a commit callback was installed.
		 */
		commit() {
			if (commitFn === NOT_MOUNTED) {
				throw new Error(
					"[mithril-lynx] commit() called before renderApp() mounted " +
						"the app. This is always a bug in the framework's own " +
						"wiring, never something app code can trigger by accident " +
						"— app code never calls commit() directly.",
				);
			}
			commitFn();
		},
	};
}
