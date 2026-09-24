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
	ontap?: (e: unknown) => unknown;
	[key: string]: unknown;
}

export interface Route {
	(defaultRoute: string, routes: Record<string, unknown | RouteResolver>): void;
	set(path: string, data?: unknown, options?: { replace?: boolean }): void;
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
	prefix: string;
	SKIP: unknown;
	Link: Component<RouteLinkAttrs>;
}

export function createRoute(): Route;

declare const route: Route;
export default route;
