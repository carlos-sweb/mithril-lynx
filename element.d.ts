// Ambient declaration for the ESM element.js (the file itself is not
// type-checked; this describes its runtime export shape for TS consumers).

export interface SelectorParams {
  onlyCurrentComponent?: boolean;
}

export interface AnimationTimingOptions {
  name?: string;
  duration?: number | string;
  delay?: number | string;
  iterationCount?: number | string;
  fillMode?: string;
  timingFunction?: string;
  direction?: string;
}

export type Keyframe = Record<string, string | number>;

export interface MainThreadElement {
  setStyleProperty(name: string, value: string | number): void;
  setStyleProperties(styles: Record<string, string | number>): void;
  setAttribute(name: string, value: unknown): void;
  querySelector(selector: string, params?: SelectorParams): MainThreadElement | null;
  querySelectorAll(selector: string, params?: SelectorParams): MainThreadElement[];
  animate(keyframes: Keyframe[], options?: AnimationTimingOptions): void;
  playAnimation(name: string): void;
  pauseAnimation(name: string): void;
  cancelAnimation(name: string): void;
  invoke(method: string, params?: Record<string, unknown>): Promise<{ code: number; data: unknown }>;
}

/** Wraps a node (anything with a `_handle`, i.e. a real LynxNodeWrapper) with imperative PAPI methods. */
export function wrapElement(node: { _handle: unknown }): MainThreadElement;
