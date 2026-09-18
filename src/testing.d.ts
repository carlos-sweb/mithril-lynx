export interface PatchApplier {
	registerPageRoot(pageRootHandle: unknown): void;
	applyPatch(ops: unknown[]): void;
}

/** See apply-patch.js's own header for the exact op vocabulary this replays. */
export function createPatchApplier(pageId: unknown, options?: { onEvent?: (id: unknown, type: string, payload: unknown) => void }): PatchApplier;

/** Installs the @lynx-js/testing-environment PAPI gap-fill mithril-lynx
 * needs, on the main-thread globals object it hands to
 * `onInjectMainThreadGlobals`. See testing.js's own header for exactly what
 * this covers. */
export function installTestingPolyfills(target: any): void;
