import type { Component } from "mithril";

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
	param(key?: string): unknown;
	back(): void;
	forward(): void;
	prefix: string;
	SKIP: unknown;
	Link: Component<RouteLinkAttrs>;
}

export function createRoute(): Route;

declare const route: Route;
export default route;
