// Ambient declaration for the ESM plugin.js (the file itself is not
// type-checked; this describes its runtime export shape for lynx.config.ts).

import type { RsbuildPlugin } from "@lynx-js/rspeedy";

export interface PluginMithrilLynxOptions {
  /** Lynx engine target SDK version. Defaults to "3.5". */
  targetSdkVersion?: string;
  /**
   * Opt back into module-level HMR. Defaults to false, which the plugin forces
   * because rspack's hot runtime can only patch modules on the background
   * thread, while Mithril view code always runs on the main thread — so HMR
   * adds hot-update error noise without ever being able to update anything.
   */
  hmr?: boolean;
  /**
   * Reload the running page after each successful dev rebuild. Defaults to
   * true. Reloading goes through the Lynx DevTool connector, which reaches the
   * device over adb, so a device connected only over Wi-Fi must be reloaded
   * manually.
   */
  liveReload?: boolean;
}

/**
 * Dual-bundle build plugin: for each configured entry, compiles the entry
 * file as the main-thread/Lepus bundle, and — if a sibling `background.ts`
 * or `background.js` file exists next to it — compiles that as the
 * background/JS-thread bundle. Pure multi-entry bundling, no code transform.
 */
export function pluginMithrilLynx(options?: PluginMithrilLynxOptions): RsbuildPlugin;
