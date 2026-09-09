// Ambient declaration for the ESM renderer/background.js (the file itself is
// not type-checked; this describes its runtime export shape for TS consumers).

export interface RenderAppOptions {
  /** Called exactly once to build the root Mithril vnode against the virtual tree. */
  root(): unknown;
}

/**
 * Renders `root()` against a virtual (op-log-recording) tree and sends the
 * resulting patch to the main thread. Call once, at background.ts's top
 * level. See the project plan, Phase 4 ("renderer mode").
 */
export function renderApp(options: RenderAppOptions): void;

/**
 * Re-invokes the app's view() (via the shim's own redraw()) and flushes the
 * resulting patch to the main thread. Call this instead of importing the
 * shim's redraw() directly in renderer-mode event handlers.
 */
export function redraw(): void;
