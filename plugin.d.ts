import type { RsbuildPlugin } from "@lynx-js/rspeedy";

export interface PluginMithrilLynxOptions {
	targetSdkVersion?: string;
	liveReload?: boolean;
}

export function pluginMithrilLynx(options?: PluginMithrilLynxOptions): RsbuildPlugin;
