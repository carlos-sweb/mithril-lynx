// Ambient declaration for the ESM list.js (the file itself is not
// type-checked; this describes its runtime export shape for TS consumers).

export interface CreateListOptions {
  itemCount: number;
  /** Must return a fresh vnode for the cell's content; may be called more than once for the same index (recycling). */
  renderItem(index: number): unknown;
  /** Defaults to String(index). Set on every item's "item-key" attribute — required by native, not just an identity hint. */
  itemKey?(index: number): string;
  className?: string;
  /** Defaults to "vertical". */
  scrollOrientation?: "vertical" | "horizontal";
  /** Defaults to "single". */
  listType?: "single" | "flow";
  /** Defaults to 1. */
  spanCount?: number;
}

export interface ListHandle {
  _handle: unknown;
  nodeType: 1;
  /** Call after mutating the underlying data so a subsequently-scrolled-into-view cell reflects the new count. */
  setItemCount(nextCount: number): void;
}

/**
 * Creates a native-recycled `<list>` element (project plan, Phase 8, Tier
 * 2). Imperative escape hatch — call from oncreate(vnode) and attach the
 * result yourself (parentNode.appendChild(list)).
 */
export function createList(parentNode: { ownerDocument: unknown }, options: CreateListOptions): ListHandle;
