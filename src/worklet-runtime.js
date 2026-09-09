// src/worklet-runtime.js
//
// Minimal, self-contained substitute for @lynx-js/react's real
// `runtime/lib/worklet-runtime` — needed because native's gesture (and,
// more generally, "Main Thread Script"/worklet) callback dispatch does NOT
// call a JS function value directly. Confirmed by reading the real, shipped
// @lynx-js/react v0.123.0 source (not guesswork — the same technique that
// resolved list.js's Tier 2 silent-failure bug):
//
//   - runtime/lib/worklet-runtime/index.js is a side-effecting module: on
//     import, if `globalThis.lynxWorkletImpl === undefined`, it calls
//     `initWorklet()`, which sets `globalThis.registerWorklet` and
//     `globalThis.runWorklet`. mithril-lynx never did this — those globals
//     were simply undefined in every app built with it.
//   - runtime/lib/worklet-runtime/workletRuntime.js's own comment on
//     `runWorklet(ctx, params, options)`: "Entrance of all worklet calls.
//     Native event touch handler will call this function." — i.e. native
//     invokes gesture callbacks BY NAME through this global, not by calling
//     the callback value itself.
//   - `validateWorklet(ctx)` there requires
//     `typeof ctx === 'object' && ctx !== null && ('_wkltId' in ctx || '_lepusWorkletHash' in ctx)`.
//     A plain JS function has `typeof fn === 'function'`, which fails this
//     check outright — explaining gesture.js's previous silent, error-free
//     failure on a real device: nothing ever rejected the plain-function
//     callback, native (or the missing `runWorklet`) just never ran it.
//   - The real function body is registered separately, keyed by a
//     `_wkltId`, via `globalThis.registerWorklet(type, id, fn)` — normally
//     done by ReactLynx's compiled snapshot codegen, which this project
//     deliberately has none of, so it's done by hand here at
//     `createGesture()` call time instead (see gesture.js).
//
// What THIS module deliberately does NOT replicate from the real
// workletRuntime.js (out of scope for v1, same spirit as list.js's/
// gesture.js's own documented cuts): WorkletRef resolution, the
// JsFunctionLifecycleManager refcounting (`runOnBackground` cross-thread
// closures), and `addEventMethodsIfNeeded`'s event-method injection
// (`e.stopPropagation()`-style calls from inside a worklet body). A gesture
// callback that only reads its event argument and/or calls other
// mithril-lynx APIs (setState, background.runOnBackground, ...) is fully
// covered; one relying on those extra pieces is not, in v1.

function ensureWorkletRuntime() {
	if (globalThis.lynxWorkletImpl !== undefined) return;
	globalThis.lynxWorkletImpl = { _workletMap: {} };
	globalThis.registerWorklet = function (_type, id, fn) {
		globalThis.lynxWorkletImpl._workletMap[id] = fn;
	};
	globalThis.runWorklet = function (ctx, params) {
		if (typeof ctx !== "object" || ctx === null || !("_wkltId" in ctx)) return;
		var fn = globalThis.lynxWorkletImpl._workletMap[ctx._wkltId];
		if (typeof fn !== "function") return;
		var args = Array.isArray(params) ? params : params != null ? [params] : [];
		// Deliberately NOT fn.apply(ctx, args): native passes gesture
		// callbacks a 2nd argument — a native "gesture controller" object
		// ({__SetGestureState, __ConsumeGesture}) — that throws "TypeError:
		// not a object" when it crosses Function.prototype.apply()'s
		// argument-list marshalling, but is fine passed positionally.
		// Confirmed on-device by bisecting each call step; matches
		// @lynx-js/react's own runWorkletImpl, which never uses apply()/
		// call() either — it does `worklet(...params_)`, a plain spread call.
		return fn.bind(ctx)(...args);
	};
}

let nextWorkletId = 1;

/**
 * Registers `fn` as a callable worklet and returns the ctx object native
 * expects in its place (`{ _wkltId }`), per `validateWorklet()`'s real
 * contract. `workletType` matches ReactLynx's own values ("main-thread" is
 * the only one mithril-lynx currently has a use for — see gesture.js).
 */
function wrapWorkletCallback(fn, workletType) {
	if (typeof fn !== "function") return fn;
	ensureWorkletRuntime();
	const id = "mithril-lynx-worklet-" + nextWorkletId++;
	globalThis.registerWorklet(workletType || "main-thread", id, fn);
	return { _wkltId: id };
}

module.exports.ensureWorkletRuntime = ensureWorkletRuntime;
module.exports.wrapWorkletCallback = wrapWorkletCallback;
