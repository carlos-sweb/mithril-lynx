// Ambient declaration for the CJS lynx-mithril-shim.js (the file itself is
// not type-checked; this describes its runtime export shape for main-thread.ts).

declare const shim: {
  (dom: unknown, vnodes: unknown, redraw?: () => void): void;
  render(rootWrapper: unknown, vnode: unknown): void;
  redraw(): void;
  createPageWrapper(pageElement: unknown): unknown;
  renderToPage(pageElement: unknown, vnode: unknown): unknown;
  createLynxWindow(pageElement: unknown): unknown;
  LynxNodeWrapper: unknown;
  LynxStyleProxy: unknown;
  normalizeEvent(rawEv: unknown, node: unknown): unknown;
};

export default shim;
