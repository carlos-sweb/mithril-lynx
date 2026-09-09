// Ambient declaration for the ESM gesture.js (the file itself is not
// type-checked; this describes its runtime export shape for TS consumers).

export const GestureType: {
  readonly COMPOSED: -1;
  readonly PAN: 0;
  readonly FLING: 1;
  readonly DEFAULT: 2;
  readonly TAP: 3;
  readonly LONGPRESS: 4;
  readonly ROTATION: 5;
  readonly PINCH: 6;
  readonly NATIVE: 7;
};

export type GestureTypeName = keyof typeof GestureType;

export interface Gesture {
  id: number;
  remove(): void;
  setState(state: number): void;
}

export interface CreateGestureOptions {
  type: number | GestureTypeName;
  callbacks?: Record<string, (...args: unknown[]) => unknown>;
  waitFor?: Gesture[];
  simultaneousWith?: Gesture[];
  continueWith?: Gesture[];
  config?: Record<string, unknown>;
}

/** Registers a gesture detector on a node (anything with a `_handle`). See the project plan, Phase 7. */
export function createGesture(node: { _handle: unknown }, options: CreateGestureOptions): Gesture;
