// test/setup.ts
//
// The minimal gap-fill on top of @lynx-js/testing-environment's own PAPI
// polyfill — same idea as mithril-lynx v1's testing.js, scoped down to only
// what v2's apply-patch.js actually calls so far (no gestures/lists yet,
// see the v2 plan's non-goals). `@lynx-js/testing-environment` already
// implements __CreateView/__CreateText/__CreateElement/__CreateRawText/
// __AppendElement/__InsertElementBefore/__RemoveElement/__SetAttribute/
// __SetClasses/__AddInlineStyle/__FlushElementTree/__GetElementUniqueID —
// the one real gap is __AddEventListener (the testing environment only
// implements the string/worklet-event __AddEvent family that ReactLynx
// uses; mithril-lynx binds real JS function listeners directly).

globalThis.onInjectMainThreadGlobals = (target: any) => {
	target.lynx.getEngine = target.lynx.getNative;

	target.__AddEventListener = (node: any, name: string, handler: (...args: unknown[]) => unknown) => {
		node.__vanillaListeners ??= {};
		(node.__vanillaListeners[name] ??= new Set()).add(handler);
	};

	target.__RemoveEventListener = (node: any, name: string, handler: unknown) => {
		node.__vanillaListeners?.[name]?.delete(handler);
	};
};
