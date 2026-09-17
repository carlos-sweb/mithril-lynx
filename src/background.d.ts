export interface RenderAppOptions {
	root: () => unknown;
	sendPatch?: (ops: unknown[]) => void;
}

export interface RenderAppHandle {
	redraw: () => void;
	document: unknown;
}

export function renderApp(options: RenderAppOptions): RenderAppHandle;
