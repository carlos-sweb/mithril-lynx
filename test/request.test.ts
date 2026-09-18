import { describe, expect, it } from "@rstest/core";
import { createRequestor } from "../src/request.js";
import { register as registerRedraw } from "../src/mount-redraw.js";

// The underlying primitive (lynx.fetch itself — redirects, AbortController,
// URLSearchParams bodies, Headers case-sensitivity) is validated on a real
// device, not here — see FETCH_INVESTIGATION.md. These tests are about the
// WRAPPER's own logic: does it build the right RequestInit, handle the
// response/error shape correctly, and refuse the options that have no
// fetch equivalent. A fake `fetch` (jsdom's real Response/Headers/
// AbortController under the hood, same as a real fetch, just no network)
// is injected via createRequestor() for exactly this reason.

function fakeResponse(body: unknown, init: { status?: number; statusText?: string } = {}) {
	const status = init.status ?? 200;
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: init.statusText ?? "",
		json: async () => body,
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	};
}

describe("request.js: m.request-shaped wrapper over lynx.fetch", () => {
	it("interpolates :params into the URL and defaults to GET", async () => {
		let seenUrl: string | undefined;
		let seenInit: any;
		const request = createRequestor((url, init) => {
			seenUrl = url;
			seenInit = init;
			return Promise.resolve(fakeResponse({ id: 42 }));
		});

		const result = await request("/users/:id", { params: { id: 42 } });
		expect(seenUrl).toBe("/users/42");
		expect(seenInit.method).toBe("GET");
		expect(result).toEqual({ id: 42 });
	});

	it("JSON-encodes a plain object body and sets Content-Type", async () => {
		let seenInit: any;
		const request = createRequestor((_url, init) => {
			seenInit = init;
			return Promise.resolve(fakeResponse({ ok: true }));
		});

		await request("/things", { method: "post", body: { name: "widget" } });
		expect(seenInit.method).toBe("POST");
		expect(seenInit.body).toBe(JSON.stringify({ name: "widget" }));
		expect(seenInit.headers["Content-Type"]).toBe("application/json; charset=utf-8");
	});

	it("passes a URLSearchParams body through unchanged (confirmed working on device)", async () => {
		let seenInit: any;
		const request = createRequestor((_url, init) => {
			seenInit = init;
			return Promise.resolve(fakeResponse({ ok: true }));
		});

		const usp = new URLSearchParams({ foo: "bar" });
		await request("/form", { method: "post", body: usp });
		expect(seenInit.body).toBe(usp);
	});

	it("rejects a FormData body immediately — confirmed absent on Lynx", async () => {
		const request = createRequestor(() => {
			throw new Error("should never reach fetch");
		});
		const fd = new FormData();
		expect(() => request("/upload", { method: "post", body: fd })).toThrow(/FormData/);
	});

	for (const [name, options] of [
		["config", { config: () => {} }],
		["async: false", { async: false }],
		["user", { user: "alice" }],
		["password", { password: "secret" }],
		["withCredentials", { withCredentials: true }],
	] as const) {
		it(`rejects "${name}" immediately — no fetch equivalent`, () => {
			const request = createRequestor(() => {
				throw new Error("should never reach fetch");
			});
			expect(() => request("/x", options as any)).toThrow();
		});
	}

	it("builds the real m.request error shape on a non-2xx response", async () => {
		const request = createRequestor(() =>
			Promise.resolve(fakeResponse({ reason: "nope" }, { status: 404, statusText: "Not Found" })),
		);

		await expect(request("/missing")).rejects.toMatchObject({
			code: 404,
			response: { reason: "nope" },
		});
	});

	it("extract() bypasses the status check entirely, like real m.request", async () => {
		const request = createRequestor(() => Promise.resolve(fakeResponse(null, { status: 500 })));
		const result = await request("/x", {
			extract: (response: any) => ({ sawStatus: response.status }),
		});
		expect(result).toEqual({ sawStatus: 500 });
	});

	it("applies a type constructor to the result", async () => {
		class User {
			name: string;
			constructor(data: { name: string }) {
				this.name = data.name;
			}
		}
		const request = createRequestor(() => Promise.resolve(fakeResponse({ name: "Ada" })));
		const result = await request<User>("/user", { type: User });
		expect(result).toBeInstanceOf(User);
		expect(result.name).toBe("Ada");
	});

	it("redraws the currently mounted app after resolving, unless background: true", async () => {
		// redraw() is scheduled (50ms delay), not synchronous or a 0ms timer
		// — see mount-redraw.js's top comment: a synchronous redraw runs
		// BEFORE this test's own .then below (chained onto request()'s
		// *returned* promise, one microtask behind request.js's internal
		// redraw call), and device testing showed Lynx's timer/rAF fire
		// before even a single pending microtask regardless of delay, up to
		// 16ms — 50ms was the first value that reliably lost that race.
		// Confirmed as a real device bug: the UI froze on "loading" forever
		// because the state update arrived after the (then too-early) render.
		let redraws = 0;
		registerRedraw(() => {
			redraws++;
		});
		const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const request = createRequestor(() => Promise.resolve(fakeResponse({})));

		await request("/x");
		await wait(60);
		expect(redraws).toBe(1);

		await request("/x", { background: true });
		await wait(60);
		expect(redraws).toBe(1); // unchanged
	});

	it("timeout aborts the underlying fetch via AbortController, not just the wait", async () => {
		let sawAbort = false;
		const request = createRequestor(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => {
						sawAbort = true;
						const error = new Error("This operation was aborted");
						error.name = "AbortError";
						reject(error);
					});
				}),
		);

		await expect(request("/slow", { timeout: 5 })).rejects.toMatchObject({ name: "AbortError" });
		expect(sawAbort).toBe(true);
	});

	it("exposes .abort() on the returned promise as a bonus (real m.request has no direct equivalent)", async () => {
		let sawAbort = false;
		const request = createRequestor(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => {
						sawAbort = true;
						reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
					});
				}),
		);

		const promise = request("/slow");
		promise.catch(() => {}); // don't let the eventual rejection be unhandled
		promise.abort();
		expect(sawAbort).toBe(true);
	});
});
