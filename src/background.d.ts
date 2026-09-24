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
