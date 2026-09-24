export interface RequestOptions<T = any> {
	method?: string;
	url?: string;
	params?: Record<string, unknown>;
	body?: unknown;
	headers?: Record<string, string>;
	timeout?: number;
	signal?: AbortSignal;
	responseType?: "json" | "text";
	serialize?: (data: unknown) => string;
	deserialize?: (data: unknown) => unknown;
	extract?: (response: unknown, options: RequestOptions<T>) => unknown;
	/** A constructor applied to the response: per element when the response
	 * is an array (matching real `m.request`), otherwise to the whole result. */
	type?: new (data: any) => T;
	background?: boolean;
	// Present on the real m.request signature but confirmed unsupported —
	// listed here (rather than omitted) so passing one is a type error at
	// the call site, not a surprise at runtime.
	config?: never;
	async?: never;
	user?: never;
	password?: never;
	withCredentials?: never;
}

export interface RequestPromise<T> extends Promise<T> {
	/** Not part of real m.request's API — free to add since Lynx's
	 * AbortController makes it a real, working cancellation, unlike the
	 * `config`-only escape hatch losing `config` takes away. */
	abort(): void;
}

export type Request = <T = any>(url: string | RequestOptions<T>, options?: RequestOptions<T>) => RequestPromise<T>;

export function createRequestor(fetchImpl?: (url: string, init: RequestInit) => Promise<Response>): Request;

declare const request: Request;
export default request;
