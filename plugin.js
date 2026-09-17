// plugin.js
//
// Rspeedy/Rsbuild plugin wiring the two-bundle build (main-thread/Lepus +
// background/JS) for mithril-lynx-v2 apps. Adapted from mithril-lynx v1's
// plugin.js — this file is build TOOLING, not the redraw/reload mechanism
// that motivated the v2 rewrite (see mithril-lynx-v2-desde-cero.md §2: v1's
// bugs lived in the shim/commit/reload layer, never here), so it is reused
// with fixes rather than rewritten from nothing. Two real changes from v1:
//
// 1. (F0.2 fix, the actual point of this file's existence in the plan)
//    `RuntimeWrapperWebpackPlugin`'s `test` regex now also matches
//    `.hot-update.js` chunks. v1's regex (`${name}/background\.js$`)
//    matched the initial background ASSET path (nested under
//    `.rspeedy/<name>/`, with a slash) but never the flat, double-
//    underscore-named hot-update chunk (`<name>__background.<hash>.hot-
//    update.js`) — confirmed with a plain regex test against both real
//    filenames, not a guess. That gap is the entire reason v1 needed a
//    runtime monkey-patch of `lynx.requireModuleAsync` in its dev-reload
//    client; v2's client has no such patch (see src/dev-reload-client.js).
//
// 2. Only ONE rendering mode exists (v2 plan §2 non-goals: no main-thread-
//    owned/data-channel modes) — so there is no mode-detection logic here,
//    `dev.hmr` is unconditionally on in dev, and every entry always gets a
//    background chunk.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { RuntimeWrapperWebpackPlugin } from "@lynx-js/runtime-wrapper-webpack-plugin";
import { LynxEncodePlugin, LynxTemplatePlugin } from "@lynx-js/template-webpack-plugin";

const PLUGIN_NAME = "mithril-lynx-v2-template-webpack";
const STYLE_CANDIDATES = ["style.css"];

const DEV_RELOAD_CLIENT_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"src",
	"dev-reload-client.js",
);

const DEV_TRANSPORT_NOOP_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"src",
	"dev-transport-noop.js",
);

/**
 * Builds the query string the in-bundle dev-reload client reads its config
 * from — unchanged from v1's version (build-tooling glue, not part of the
 * bug this rewrite is about).
 */
function createDevReloadClientQuery(api, environment, entryName) {
	const config = environment.config ?? {};
	const dev = config.dev ?? {};
	const server = config.server ?? {};
	const devServer = api.context.devServer ?? {};
	const hostname = dev.client?.host || devServer.hostname || server.host || "";
	const port = devServer.port ?? server.port ?? "";
	const protocol = devServer.https ? "https" : "http";
	const assetPrefix = (typeof dev.assetPrefix === "string" ? dev.assetPrefix : "/").replaceAll(
		"<port>",
		String(port),
	);
	const base = /^https?:\/\//.test(assetPrefix)
		? assetPrefix
		: `${protocol}://${hostname}${port ? `:${port}` : ""}${assetPrefix}`;
	const clientBundleUrl = new URL(
		`${entryName}.bundle`,
		base.endsWith("/") ? base : `${base}/`,
	).toString();
	const params = new URLSearchParams({
		hostname,
		port: String(port),
		pathname: "/rsbuild-hmr",
		protocol: devServer.https ? "wss" : "ws",
		"bundle-url": clientBundleUrl,
	});
	if (environment.webSocketToken) params.set("token", environment.webSocketToken);
	return params.toString();
}

function findSibling(dir, candidates) {
	for (const name of candidates) {
		const candidate = path.join(dir, name);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

function packageRootOf(resolvedFile, expectedName) {
	let dir = path.dirname(resolvedFile);
	for (let i = 0; i < 10; i++) {
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
			if (pkg.name === expectedName) return dir;
		} catch {
			// keep walking
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

export function pluginMithrilLynxV2(options = {}) {
	const targetSdkVersion = options.targetSdkVersion ?? "3.5";
	const liveReload = options.liveReload ?? true;

	return {
		name: PLUGIN_NAME,
		setup(api) {
			api.expose(Symbol.for("LynxTemplatePlugin"), { LynxTemplatePlugin });

			// One mode only -> dev.hmr is unconditionally on in dev (v1 had to
			// detect renderer-mode-vs-not here; v2 has no "not").
			api.modifyRsbuildConfig({
				handler: (config, { mergeRsbuildConfig }) => mergeRsbuildConfig(config, { dev: { hmr: true } }),
				order: "post",
			});

			// dev.hmr:true makes Rsbuild/Rspeedy inject its own HMR transport
			// client (a second WebSocket to /rsbuild-hmr) alongside the
			// in-bundle client above — re-alias it to a no-op so `module.hot`
			// stays live without a competing channel (same fix v1 F2 made).
			api.modifyBundlerChain({
				handler: (chain, { isDev }) => {
					if (!isDev) return;
					chain.resolve.alias.set("@lynx-js/webpack-dev-transport/client", DEV_TRANSPORT_NOOP_PATH);
				},
				order: "post",
			});

			api.modifyBundlerChain((chain, { isDev, environment }) => {
				// Force a single resolved copy of "mithril-runtime" and
				// "mithril-lynx-v2" — a `file:`-linked local package can
				// otherwise resolve a second physical copy with its own
				// module-level state (this exact class of bug bit v1 twice:
				// mithril's emptyAttrs singleton, and mithril-lynx's own
				// per-app render state — see mithril-lynx/plugin.js's
				// comments for the on-device symptom).
				try {
					const appRequire = createRequire(path.join(process.cwd(), "package.json"));
					const mithrilDir = path.dirname(appRequire.resolve("mithril-runtime/package.json"));
					chain.resolve.alias.set("mithril-runtime", mithrilDir);
				} catch {
					// App has no local "mithril-runtime" resolvable from its own root.
				}
				// Note: v1 also force-aliased its OWN package name here (a
				// second copy of mithril-lynx would mean two disconnected
				// renderers with separate module-level state — see
				// mithril-lynx/plugin.js's comment for the on-device
				// symptom). v2's per-app state lives inside closures created
				// by `renderApp()`/`setupRenderer()` calls, not module-level
				// variables — same class of bug can't reappear the same way,
				// so this dedup isn't reproduced here. Revisit if a
				// multi-copy scenario (npm link, a component library
				// nesting its own copy) turns up the same symptom in
				// practice.

				const rawEntries = Object.entries(chain.entryPoints.entries() ?? {});
				chain.entryPoints.clear();

				for (const [name, entry] of rawEntries) {
					const value = entry.values()?.[0];
					const imports = typeof value === "string" || Array.isArray(value) ? value : value?.import;
					const mtSource = Array.isArray(imports) ? imports[0] : imports;
					if (typeof mtSource !== "string") continue;

					const dir = path.dirname(mtSource);
					const bgSource = findSibling(dir, ["background.ts", "background.js"]);
					const cssSource = findSibling(dir, STYLE_CANDIDATES);
					if (bgSource == null) {
						throw new Error(
							`[mithril-lynx-v2] entry "${name}": no sibling background.ts/background.js found next to ${mtSource}. ` +
								"mithril-lynx-v2 has exactly one rendering mode and it always needs a background entry — see the plan's §2 non-goals.",
						);
					}

					const bgEntry = `${name}__background`;
					const mtEntry = `${name}__main-thread`;
					const bgAsset = `.rspeedy/${name}/background.js`;
					const mtAsset = `.rspeedy/${name}/main-thread.js`;

					const bgImports = isDev && liveReload
						? [`${DEV_RELOAD_CLIENT_PATH}?${createDevReloadClientQuery(api, environment, name)}`, bgSource]
						: bgSource;

					chain.entry(bgEntry).add({ import: bgImports, filename: bgAsset });
					chain.entry(mtEntry).add({
						import: cssSource != null ? [mtSource, cssSource] : [mtSource],
						filename: mtAsset,
					});

					chain.plugin(`template-${name}`).use(LynxTemplatePlugin, [
						{
							...LynxTemplatePlugin.defaultOptions,
							filename: `${name}.bundle`,
							intermediate: `.rspeedy/${name}`,
							chunks: [bgEntry, mtEntry],
							dsl: "react_nodiff",
							targetSdkVersion,
							cssPlugins: [],
						},
					]);

					// --- F0.2 fix: the actual change this plugin exists to make ---
					// v1: `test: new RegExp(`${name}/background\\.js$`)` matches
					// the initial asset (`.rspeedy/<name>/background.js`, a
					// nested PATH using a slash) but never a hot-update chunk
					// (`<bgEntry>.<hash>.hot-update.js` — a FLAT file named
					// after the webpack chunk NAME, with a double underscore,
					// no slash). Verified against both real filename shapes
					// with a plain regex test, not a live build, before
					// writing this — see the plan's §8 F0.2 entry. Requiring
					// `${name}[_/]` scopes the match to just this entry's own
					// chunks (so a multi-entry app's OTHER pages' background
					// chunks aren't double-wrapped by this instance) while
					// still excluding the main-thread/lepus asset, which
					// never contains "background".
					chain.plugin(`runtime-wrapper-${name}`).use(
						RuntimeWrapperWebpackPlugin,
						[
							{
								targetSdkVersion,
								test: new RegExp(`(^|/)${name}[_/].*background.*\\.js$`),
							},
						],
					);

					console.info(
						`[mithril-lynx-v2:build] entry="${name}" hmr=true liveReload=${liveReload} ` +
							`bgEntry=${bgEntry} mtEntry=${mtEntry} targetSdk=${targetSdkVersion}`,
					);
				}

				chain.plugin("encode").use(LynxEncodePlugin, []);

				chain.plugin("before-encode").use({
					apply(compiler) {
						compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
							const hooks = LynxTemplatePlugin.getLynxTemplatePluginHooks(compilation);
							hooks.beforeEncode.tap(PLUGIN_NAME, (args) => {
								const pageName = args.intermediate ? path.basename(args.intermediate) : "";
								if (!pageName) return args;

								const bgAsset = `.rspeedy/${pageName}/background.js`;
								const mtAsset = `.rspeedy/${pageName}/main-thread.js`;

								const backgroundAsset = compilation.getAsset(bgAsset);
								const mainThreadAsset = compilation.getAsset(mtAsset);
								if (!mainThreadAsset) return args;

								args.encodeData.compilerOptions.targetSdkVersion = targetSdkVersion;
								args.encodeData.compilerOptions.enableEventRefactor = true;
								args.encodeData.sourceContent.config.enableEventHandleRefactor = true;

								args.encodeData.manifest = backgroundAsset
									? { [backgroundAsset.name]: backgroundAsset.source.source().toString() }
									: {};
								args.encodeData.lepusCode = {
									root: mainThreadAsset,
									chunks: [],
									filename: mainThreadAsset.name,
								};

								return args;
							});
						});
					},
				});
			});
		},
	};
}
