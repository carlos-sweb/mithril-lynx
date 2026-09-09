// Ambient declaration for the ESM plugin.js (the file itself is not
// type-checked; this describes its runtime export shape for lynx.config.ts).

import type { RsbuildPlugin } from "@lynx-js/rspeedy";

export interface PluginMithrilLynxOptions {
  /** Lynx engine target SDK version. Defaults to "3.5". */
  targetSdkVersion?: string;
}

/**
 * Dual-bundle build plugin: for each configured entry, compiles the entry
 * file as the main-thread/Lepus bundle, and — if a sibling `background.ts`
 * or `background.js` file exists next to it — compiles that as the
 * background/JS-thread bundle. Pure multi-entry bundling, no code transform.
 */
export function pluginMithrilLynx(options?: PluginMithrilLynxOptions): RsbuildPlugin;
