export interface RenderAppOptions {
	root: () => unknown;
	sendPatch?: (ops: unknown[]) => void;
}

/** Minimal shape of a fake-DOM node exposed for tests and HMR glue — enough
 * to dispatch a synthetic event (e.g. `node.dispatchEvent({ type: "tap" })`)
 * and correlate with a background-side id. */
export interface LynxNode {
	dispatchEvent(event: unknown): unknown;
}

/** A fake-DOM element (`vnode.dom` of any element vnode). Its UI methods run
 * on the main thread right after the patch that carries them is flushed, so
 * they are safe from `oncreate`; no `id` or selector query is involved. */
export interface LynxElement extends LynxNode {
	/** Calls a native UI method (`getValue`, `scrollTo`, `autoScroll`, …).
	 * Rejects with an `Error` carrying the native `code`/`data`, or when the
	 * element is removed before the call runs. */
	invoke<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
	/** The native `focus` UI method (fire-and-forget). */
	focus(): void;
	/** The native `blur` UI method (fire-and-forget). */
	blur(): void;
}

/** `vnode.dom` of an `input` or `textarea`. `value` mirrors the native text:
 * synced from every event of the field, and sent with `setValue` when set to
 * something else. */
export interface LynxFormFieldElement extends LynxElement {
	value: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
	/** Focuses the field once, on creation (set through the `autofocus` attribute). */
	autofocus: boolean;
	setSelectionRange(selectionStart: number, selectionEnd: number): Promise<unknown>;
}

/** The subset of the fake-DOM document exposed on the render handle — used
 * by tests and by an app's own HMR glue, never by the channel wiring. */
export interface LynxDocument {
	getNodeById(id: number): LynxNode | null;
}

export interface RenderAppHandle {
	redraw: () => void;
	document: LynxDocument;
}

export function renderApp(options: RenderAppOptions): RenderAppHandle;
