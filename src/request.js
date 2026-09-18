// src/request.js
//
// `m.request`-shaped wrapper over `lynx.fetch` — the subset confirmed
// faithful in FETCH_INVESTIGATION.md / .omo/plans/m-request-fetch-lynx.md.
// Every option below is either "works the same as real m.request" or
// throws immediately with a clear message pointing at the doc — never a
// silent behavior difference. See FETCH_INVESTIGATION.md §3 for the full
// option-by-option table this file implements.
//
// Explicitly NOT supported, by design, confirmed unfixable on Lynx:
// - `config(xhr)`: fetch has no live object to hand back.
// - `body` as `FormData`: confirmed absent at runtime (typeof FormData
//   === "undefined"). `URLSearchParams` bodies DO work — confirmed on
//   device — and need no special-casing here beyond not JSON-stringifying
//   them.
// - `responseType: "blob"`/`"document"`: no `.blob()` on Lynx's `Body`;
//   `"document"` has no meaning outside a browser DOM.
// - `user`/`password` (inline Basic Auth), `withCredentials`,
//   `async: false`: XMLHttpRequest/browser-only concepts with no `fetch`
//   equivalent, confirmed (withCredentials: no CORS model on Lynx;
//   user/password: no `btoa` to build the Authorization header even if
//   we wanted to guess one).

import buildPathname from "mithril-runtime/pathname/build.js";
import { redraw as sharedRedraw } from "./mount-redraw.js";

const UNSUPPORTED = [
	["config", (o) => o.config != null],
	["async: false", (o) => o.async === false],
	["user", (o) => typeof o.user === "string"],
	["password", (o) => typeof o.password === "string"],
	["withCredentials", (o) => o.withCredentials === true],
];

function checkUnsupported(options) {
	for (const [name, matches] of UNSUPPORTED) {
		if (matches(options)) {
			throw new Error(
				`[mithril-lynx/request] "${name}" is not supported — Lynx's fetch has no equivalent ` +
					"(see FETCH_INVESTIGATION.md for exactly why). This throws instead of silently " +
					"behaving differently from what you asked for.",
			);
		}
	}
}

function hasHeader(headers, name) {
	for (const key in headers) {
		if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === name) return true;
	}
	return false;
}

function applyType(data, Type) {
	if (typeof Type !== "function") return data;
	if (Array.isArray(data)) return data.map((item) => new Type(item));
	return new Type(data);
}

/**
 * @param {(url: string, init: object) => Promise<Response>} [fetchImpl] -
 *   Defaults to `lynx.fetch`, looked up lazily (not at module load time,
 *   so importing this file never requires `lynx` to already exist) —
 *   same pattern route.js uses for `renderApp`. Tests inject a fake here
 *   instead of hitting a real network.
 */
export function createRequestor(fetchImpl) {
	const doFetch = fetchImpl || ((url, init) => lynx.fetch(url, init));

	return function request(url, options) {
		if (typeof url !== "string") {
			options = url;
			url = url.url;
		} else if (options == null) {
			options = {};
		}
		checkUnsupported(options);

		if (typeof FormData !== "undefined" && options.body instanceof FormData) {
			throw new Error(
				"[mithril-lynx/request] FormData bodies are not supported — Lynx has no FormData " +
					"at runtime (confirmed absent, see FETCH_INVESTIGATION.md). Use lynx.fetch directly " +
					"if you have another way to send this data, or restructure it as plain JSON.",
			);
		}

		const method = options.method != null ? options.method.toUpperCase() : "GET";
		const path = buildPathname(url, options.params);
		const headers = Object.assign({}, options.headers);

		let body;
		if (options.body != null) {
			if (typeof URLSearchParams !== "undefined" && options.body instanceof URLSearchParams) {
				// Confirmed on device: fetch sets Content-Type automatically for
				// this body type, exactly like a real browser.
				body = options.body;
			} else if (typeof options.serialize === "function") {
				body = options.serialize(options.body);
			} else {
				body = JSON.stringify(options.body);
				if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json; charset=utf-8";
			}
		}
		if (typeof options.deserialize !== "function" && !hasHeader(headers, "accept")) {
			headers["Accept"] = "application/json, text/*";
		}

		// Real cancellation/timeout — confirmed working on device (unlike
		// what an earlier version of the investigation assumed): aborting
		// actually tears down the in-flight connection, not just abandons
		// the wait. `options.signal` (if given) is linked into our own
		// controller so a caller-provided signal and our timeout can both
		// trigger the same abort.
		const ctrl = new AbortController();
		if (options.signal) {
			if (options.signal.aborted) ctrl.abort();
			else options.signal.addEventListener("abort", () => ctrl.abort());
		}
		let timeoutId;
		if (options.timeout) {
			const schedule = typeof lynx !== "undefined" && typeof lynx.setTimeout === "function"
				? lynx.setTimeout.bind(lynx)
				: setTimeout;
			timeoutId = schedule(() => ctrl.abort(), options.timeout);
		}
		function clearRequestTimeout() {
			if (timeoutId == null) return;
			const clear = typeof lynx !== "undefined" && typeof lynx.clearTimeout === "function"
				? lynx.clearTimeout.bind(lynx)
				: clearTimeout;
			clear(timeoutId);
		}

		const responseType = options.responseType || (typeof options.extract === "function" ? "" : "json");

		const promise = doFetch(path, { method, headers, body, signal: ctrl.signal }).then((response) => {
			clearRequestTimeout();

			if (typeof options.extract === "function") {
				// Matches real m.request: extract() bypasses the status check
				// entirely — it decides success/failure itself.
				return options.extract(response, options);
			}

			const ok = response.ok || response.status === 304;
			const bodyPromise = responseType === "text" ? response.text() : response.json();
			return bodyPromise.then((data) => {
				if (typeof options.deserialize === "function") data = options.deserialize(data);
				if (!ok) {
					const error = new Error(typeof data === "string" ? data : response.statusText);
					error.code = response.status;
					error.response = data;
					throw error;
				}
				return applyType(data, options.type);
			});
		});

		const result = promise.then(
			(value) => {
				if (options.background !== true) sharedRedraw();
				return value;
			},
			(error) => {
				clearRequestTimeout();
				if (options.background !== true) sharedRedraw();
				throw error;
			},
		);

		// Not part of real m.request's API (there, you can only reach
		// xhr.abort() through `config`) — free to add since we already have
		// the controller, and it's exactly the escape hatch losing `config`
		// takes away. Documented in FETCH_INVESTIGATION.md, not hidden.
		result.abort = () => ctrl.abort();
		return result;
	};
}

const request = createRequestor();
export default request;
