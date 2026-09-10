// Ambient declaration for the ESM navigation.js (the file itself is not
// type-checked; this describes its runtime export shape for TS consumers).

import type { Component, ComponentTypes } from "mithril";

export interface Nav {
  /** Pushes a new screen onto the stack and redraws. */
  push(component: ComponentTypes<any, any>, attrs?: Record<string, unknown>): void;
  /** Replaces the current top screen without growing the stack, and redraws. */
  replace(component: ComponentTypes<any, any>, attrs?: Record<string, unknown>): void;
  /** Pops the top screen and redraws. Returns false (a no-op) at the root screen. */
  pop(): boolean;
  /** True if pop() would actually pop something (stack depth > 1). */
  canGoBack(): boolean;
  /** Current stack depth (1 at the root screen). */
  depth(): number;
}

export interface Navigator extends Nav {
  /** Mithril component that always renders whichever screen is on top of the stack. */
  Navigator: Component;
}

export interface CreateNavigatorOptions {
  /** The root screen, mounted first. */
  initial: ComponentTypes<any, any>;
  initialAttrs?: Record<string, unknown>;
}

/**
 * Creates a stack-based, in-memory navigator (no m.route, no URLs — see
 * navigation.js's header comment for why). Every screen the navigator
 * renders receives its own attrs plus a `nav` prop shaped like {@link Nav}.
 */
export function createNavigator(options: CreateNavigatorOptions): Navigator;
