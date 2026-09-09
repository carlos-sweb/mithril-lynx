// Ambient declaration for the ESM main-thread.js (the file itself is not
// type-checked; this describes its runtime export shape for TS consumers).

/** Returns the most recently received data (from __RenderPage/__UpdatePage or a background push). */
export function getData<T = unknown>(): T | undefined;

/** Sends a named action to the background thread's setBackgroundEventHandler. */
export function dispatchToBackground(handlerName: string, data?: unknown): void;

export interface SetupAppOptions<TInput = unknown, TData = TInput> {
  /** Called exactly once, on the first __RenderPage, to build the root Mithril vnode. */
  root(): unknown;
  /** Optional transform applied to raw engine/background data before storing it. */
  processData?(data: TInput): TData;
  /**
   * When true (default), pushes processed data to the background thread on
   * every __RenderPage/__UpdatePage, and listens for background-pushed
   * updates, redrawing via Mithril's own shim.redraw().
   */
  enableBackgroundSync?: boolean;
}

/**
 * Wires the Lynx engine's page lifecycle (__RenderPage/__UpdatePage/
 * __DestroyLifetime) to a Mithril app: renders `root()` once, then calls
 * the shim's redraw() on every subsequent data push. See the project plan,
 * Phase 3 ("data-channel mode").
 */
export function setupApp<TInput = unknown, TData = TInput>(
  options: SetupAppOptions<TInput, TData>,
): void;

/**
 * Registers a handler background.js's runOnMainThread(key, ...args) can
 * call by name. See the project plan, Phase 6.
 */
export function registerHandler(key: string, fn: (...args: unknown[]) => unknown): void;

/**
 * Calls a handler background.js registered via registerHandler(key, fn).
 * Args and the resolved value must be JSON-serializable.
 */
export function runOnBackground<T = unknown>(key: string, ...args: unknown[]): Promise<T>;
