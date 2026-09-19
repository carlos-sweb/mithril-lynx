// Ambient declaration for the ESM src/list-cell.js — the background-thread
// half of native list support. mithril-lynx-ui's <List>/<FeedList> call
// this once per item, from the SAME thread/document as the rest of the
// app's own tree — see that file's own header for why.

export interface ListCell {
	typeKey: string;
	containerId: number;
	ops: unknown[];
	rootChildIds: number[];
}

export function renderListCell(
	document: unknown,
	render: (dom: unknown, vnodes: unknown[], redraw: () => void) => void,
	redraw: () => void,
	renderItem: (item: unknown, index: number) => unknown,
	item: unknown,
	index: number,
): ListCell;
