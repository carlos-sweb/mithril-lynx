import type { RsbuildPlugin } from "@lynx-js/rspeedy";

export interface PluginMithrilLynxV2Options {
	targetSdkVersion?: string;
	liveReload?: boolean;
}

export function pluginMithrilLynxV2(options?: PluginMithrilLynxV2Options): RsbuildPlugin;
