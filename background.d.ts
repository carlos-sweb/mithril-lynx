// Ambient declaration for the ESM background.js (the file itself is not
// type-checked; this describes its runtime export shape for TS consumers).

export type StoreData = Record<string, unknown>;

export interface SetDataOptions {
  /** Set false to update the store without pushing a sync to the main thread. Defaults to true. */
  shouldSyncToMainThread?: boolean;
}

/** Returns the background thread's mutable data store. */
export function getData<T = StoreData>(): T;

/** Merges `patch` into the store, then (by default) pushes the changed keys to the main thread. */
export function setData(patch: StoreData, options?: SetDataOptions): void;

/**
 * Registers the single handler invoked for every dispatchToBackground() call
 * made from the main thread, as (handlerName, data).
 */
export function setBackgroundEventHandler(
  handleEvent: (handlerName: string, data: unknown) => unknown,
): void;

/**
 * Wires the background thread's core-context listeners for the
 * main-thread <-> background-thread data channel. Call once, at
 * background.ts's top level. See the project plan, Phase 3.
 */
export function setupBackground(): void;

export interface BackgroundRef {
  /** Resolves with the native method's success data, rejects with its failure data. */
  invoke(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * A background-thread ref: imperative calls to a native element identified
 * by a CSS selector, via lynx.createSelectorQuery(). See the project plan,
 * Phase 5.
 */
export function createRef(selector: string): BackgroundRef;

/**
 * Registers a handler main-thread.js's runOnBackground(key, ...args) can
 * call by name. See the project plan, Phase 6.
 */
export function registerHandler(key: string, fn: (...args: unknown[]) => unknown): void;

/**
 * Calls a handler main-thread.js registered via registerHandler(key, fn).
 * Args and the resolved value must be JSON-serializable.
 */
export function runOnMainThread<T = unknown>(key: string, ...args: unknown[]): Promise<T>;
