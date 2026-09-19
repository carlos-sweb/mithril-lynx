// Ambient declaration for the ESM src/list-support.js — the main-thread
// half of native list support. Not meant to be imported directly by app
// code; apply-patch.js's own Op.CreateList case is the only caller. See
// list-cell.d.ts for the background-thread half an app actually uses.

export function createNativeList(
	pageId: number,
	scrollOrientation: string,
	listType: string,
	spanCount: number,
	createPatchApplier: (pageId: number, options?: { onEvent?: Function; flush?: boolean }) => object,
	onEvent?: Function,
): { handle: unknown; setCells: (cells: unknown[]) => void };
