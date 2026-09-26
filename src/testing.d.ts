export interface PatchApplier {
	registerPageRoot(pageRootHandle: unknown): void;
	applyPatch(ops: unknown[]): void;
	/** The real PAPI element handle for a given background-side id, or
	 * `undefined` if nothing was ever created for it. */
	getHandle(id: unknown): unknown;
	/** Neutralizes every native list's callbacks (for `__DestroyLifetime`). */
	dispose(): void;
}

/** See apply-patch.js's own header for the exact op vocabulary this replays. */
export function createPatchApplier(
	pageId: unknown,
	options?: { onEvent?: (id: unknown, type: string, payload: unknown, seq?: number) => void; flush?: boolean },
): PatchApplier;

/** Installs the @lynx-js/testing-environment PAPI gap-fill mithril-lynx
 * needs, on the main-thread globals object it hands to
 * `onInjectMainThreadGlobals`. See testing.js's own header for exactly what
 * this covers. */
export function installTestingPolyfills(target: any): void;

/** Every `__InvokeUIMethod` call made through the testing stand-in, in order. */
export const uiMethodCalls: { element: unknown; method: string; params: Record<string, unknown> }[];

/** Sets how the `__InvokeUIMethod` stand-in answers (`null`: `{ code: 0 }` to every call). */
export function setUIMethodResponder(
	responder: ((element: unknown, method: string, params: Record<string, unknown>) => { code: number; data?: unknown }) | null,
): void;
