/**
 * Minimal Mithril-style component type. Declared locally because this
 * package's runtime peer is `mithril-runtime`, which ships no TypeScript
 * types of its own; the previous `import type { Component } from "mithril"`
 * depended on an undeclared module. `view`'s return is typed `any` so
 * `route.Link` stays assignable to a caller's own `m()` typed against
 * `@types/mithril`.
 */
export interface Component<Attrs = unknown> {
	view(vnode: { attrs: Attrs; children?: unknown }): any;
}

export interface RouteResolver {
	onmatch?(args: Record<string, string>, requestedPath: string, route: string): unknown;
	render?(vnode: unknown): unknown;
}

export interface RouteLinkAttrs {
	href: string;
	selector?: string;
	params?: Record<string, unknown>;
	options?: { replace?: boolean };
	disabled?: boolean;
	ontap?: ((e: unknown) => unknown) | { handleEvent(e: unknown): void };
	[key: string]: unknown;
}

export interface RouteSetOptions {
	/** Overwrite the current history entry instead of pushing a new one. */
	replace?: boolean;
	/** Merged into the route's params; restored by back()/forward(). */
	state?: Record<string, unknown>;
	/** Accepted for m.route compatibility; ignored (no title bar). */
	title?: string;
}

export interface ListenBackButtonOptions {
	/** Global event the host sends when back is pressed. @defaultValue "mithrilLynx:back" */
	eventName?: string;
	/** Called with canGoBack() right away and whenever it changes — e.g. to
	 * enable/disable the host's OnBackPressedCallback through a native module. */
	onCanGoBackChange?: (canGoBack: boolean) => void;
}

export interface Route {
	/** `defaultRoute` is required: Lynx has no URL to start from. */
	(defaultRoute: string, routes: Record<string, unknown | RouteResolver>): void;
	/** Updates the history now; the new screen resolves on the next microtask
	 * (like m.route), so get() returns the previous path until then. */
	set(path: string, data?: unknown, options?: RouteSetOptions): void;
	/** The current path, decoded. */
	get(): string | undefined;
	/** Returns the named route parameter (with `key`), or the whole params
	 * object (without). Typed `unknown` because the value can be a string
	 * (path params), a string|boolean (query params — `"true"`/`"false"` are
	 * coerced), or anything passed as `data` to `set(path, data)`; the common
	 * path-param case is always a string. */
	param(key?: string): unknown;
	/** Walks back one entry; returns `false` (without navigating) at the top
	 * of the history stack so a back affordance can disable itself. */
	back(): boolean;
	/** Walks forward one entry; returns `false` (without navigating) at the
	 * end of the history stack so a forward affordance can disable itself. */
	forward(): boolean;
	/** Whether back() would navigate. */
	canGoBack(): boolean;
	/** Opt-in Android back button bridge (see ROUTE.md). Returns a function that stops listening. */
	listenBackButton(options?: ListenBackButtonOptions): () => void;
	prefix: string;
	SKIP: unknown;
	Link: Component<RouteLinkAttrs>;
}

export function createRoute(): Route;

/** Default event name listened to by `route.listenBackButton()`. */
export declare const BACK_EVENT_NAME: string;

declare const route: Route;
export default route;
