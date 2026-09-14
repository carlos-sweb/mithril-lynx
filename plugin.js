// plugin.js
//
// Generalized version of lynx-examples/examples/vanilla/plugin.ts's
// dual-bundle build pattern, published as a reusable Rsbuild/Rspeedy plugin
// instead of being copy-pasted per app.
//
// Convention: for each configured entry, the entry's import path names a
// "main-thread" file. If a sibling "background.ts"/"background.js" exists
// next to it, it is picked up automatically and compiled as a second Lynx
// bundle chunk (the background/JS-thread bundle), while the main-thread file
// is always compiled and encoded as lepus (main-thread/Lepus VM chunk).
//
// This is pure multi-entry bundling, no AST transform of user code: apps
// author two plain files (main-thread.ts + optional background.ts) and this
// plugin wires them into the two Lynx bundle slots. See mithril-lynx's
// project plan, Phase 2.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { RuntimeWrapperWebpackPlugin } from "@lynx-js/runtime-wrapper-webpack-plugin";
import { LynxEncodePlugin, LynxTemplatePlugin } from "@lynx-js/template-webpack-plugin";

const PLUGIN_NAME = "mithril-lynx-template-webpack";

const BACKGROUND_CANDIDATES = ["background.ts", "background.js"];
const STYLE_CANDIDATES = ["style.css"];

// Live reload's client only runs where a full JS engine with Native Module
// access exists: the background/JS thread. The main-thread/Lepus VM cannot
// use it. An app without background.ts therefore gets a synthetic background
// entry in development; see `includeBackground` below. Imported by this
// resolved absolute path directly (see the entry-construction loop below),
// not through a "mithril-lynx/..." bare specifier — that collides with the
// package's own broader "mithril-lynx" resolve alias.
const DEV_RELOAD_CLIENT_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"src",
	"dev-reload-client.js",
);

function createDevReloadClientQuery(api, environment, entryName) {
	const config = environment.config ?? {};
	const dev = config.dev ?? {};
	const server = config.server ?? {};
	const devServer = api.context.devServer ?? {};
	// Rsbuild resolves this to the LAN address it advertises when server.host is
	// 0.0.0.0, which is the address a physical Lynx Go device can actually use.
	const hostname = dev.client?.host || devServer.hostname || server.host || "";
	const port = devServer.port ?? server.port ?? "";
	const protocol = devServer.https ? "https" : "http";
	// At this point in the pipeline Rsbuild hasn't started the dev server yet,
	// so `dev.assetPrefix` (when it's the default, host-derived one — see
	// @lynx-js/rsbuild-plugin) still contains the literal, unsubstituted
	// "<port>" placeholder it's only resolved to a real port number later, in
	// its own `printUrls` callback. `hostname`/`port` above are already the
	// real values, though, so resolve the placeholder the same way that
	// callback does rather than trusting assetPrefix as pre-resolved.
	const assetPrefix = (typeof dev.assetPrefix === "string" ? dev.assetPrefix : "/").replaceAll(
		"<port>",
		String(port),
	);
	const base = /^https?:\/\//.test(assetPrefix)
		? assetPrefix
		: `${protocol}://${hostname}${port ? `:${port}` : ""}${assetPrefix}`;
	const bundleUrl = new URL(`${entryName}.bundle`, base.endsWith("/") ? base : `${base}/`).toString();
	const params = new URLSearchParams({
		hostname,
		port: String(port),
		pathname: "/rsbuild-hmr",
		protocol: devServer.https ? "wss" : "ws",
		"bundle-url": bundleUrl,
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

/**
 * Walks up from a resolved file to the root of the package that owns it,
 * verified by name rather than assumed from the layout — this package's
 * exports map deliberately doesn't expose ./package.json, so the usual
 * require.resolve("<pkg>/package.json") trick isn't available here.
 */
function packageRootOf(resolvedFile) {
	let dir = path.dirname(resolvedFile);
	for (let i = 0; i < 10; i++) {
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
			if (pkg.name === "mithril-lynx") return dir;
		} catch {
			// keep walking
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

export function pluginMithrilLynx(options = {}) {
	const targetSdkVersion = options.targetSdkVersion ?? "3.5";
	const hmr = options.hmr ?? false;

	return {
		name: PLUGIN_NAME,
		setup(api) {
			// Keep the template plugin discoverable by Rspeedy's Lynx internals.
			api.expose(Symbol.for("LynxTemplatePlugin"), { LynxTemplatePlugin });

			// setupApp()'s render model has no per-module "accept and patch"
			// story (rendering is driven by native __RenderPage/__UpdatePage
			// events, not by re-executing a hot-swapped module) -- module-level
			// HMR's eval'd *.hot-update.js chunks also aren't runtime-wrapped
			// the way the real background.js bundle is, and fail native-side
			// with "ReferenceError: exports is not defined" if hot is left on.
			// Force dev.hmr off (unless the app explicitly set it) so the dev
			// client's ok() handler takes its other branch -- a full native
			// Page.reload -- which is the one live-reload path this framework
			// actually supports cleanly. dev.liveReload stays at its default.
			api.modifyRsbuildConfig({
				// Not a plain default: Rsbuild has already stamped dev.hmr:true onto
				// the config by the time ANY hook sees it (even api.getRsbuildConfig
				// ("original")), so there's no reliable way to tell "the app asked for
				// hot module replacement" apart from "Rsbuild defaulted it" -- this
				// always wins, with an explicit opt-out via pluginMithrilLynx({ hmr })
				// for anyone who's fixed up their own app-level accept() story and the
				// RuntimeWrapperWebpackPlugin gap noted below.
				handler: (config, { mergeRsbuildConfig }) => mergeRsbuildConfig(config, { dev: { hmr } }),
				order: "post",
			});

			api.modifyBundlerChain((chain, { isDev, environment }) => {
				// mithril-lynx's own src/lynx-mithril-shim.js deep-imports mithril's
				// internal render/cachedAttrsIsStaticMap.js (and its emptyAttrs
				// singleton). If the app's own `require("mithril")` resolves to a
				// DIFFERENT physical copy of the package than the one mithril-lynx
				// itself was installed/linked with — the norm for a `file:`-linked
				// local package, whose own node_modules (built for ITS OWN tests)
				// shadows Node's normal directory-walk resolution once linked — the
				// two copies' emptyAttrs singletons differ. The shim then can't
				// recognize the app's legitimately-reused empty-attrs object as
				// such, and Mithril's own updateAttrs() misfires its "Don't reuse
				// attrs object" warning on every plain `m(tag, null, ...)` element,
				// every redraw. Force a single resolution by aliasing "mithril" to
				// whatever copy the app itself resolves from its own project root.
				try {
					const appRequire = createRequire(path.join(process.cwd(), "package.json"));
					// Resolve the PACKAGE DIRECTORY (not mithril's own main entry
					// file) — a prefix alias needs "mithril/render/x" to rewrite to
					// "<dir>/render/x", which only works aliased to a directory.
					const mithrilDir = path.dirname(appRequire.resolve("mithril/package.json"));
					chain.resolve.alias.set("mithril", mithrilDir);
				} catch {
					// App has no local "mithril" resolvable from its own root —
					// leave resolution as-is rather than guessing.
				}

				// Same class of problem, worse symptom: mithril-lynx itself keeps
				// per-app state in module-level variables — the shim's rootWrapper/
				// redraw/runRender, main-thread.js's latestData and its cross-thread
				// handler maps, background.js's mirror of those. Two physical copies
				// means two disconnected renderers: the app renders through one, and
				// any LIBRARY that depends on mithril-lynx (a component library, say,
				// resolving its own nested copy once linked) calls shim.redraw() on
				// the other — whose `redraw` is still null. That's a silent no-op:
				// no error, nothing logged, components simply never update. Confirmed
				// on real hardware 2026-09-11 while building mithril-lynx-ui, where
				// it read as "the animation just doesn't run".
				try {
					const appRequire = createRequire(path.join(process.cwd(), "package.json"));
					const selfDir = packageRootOf(appRequire.resolve("mithril-lynx"));
					if (selfDir != null) {
						// The bare specifier has to point at the entry FILE: aliasing it
						// to the directory would bypass this package's own exports map
						// (which has no "main" to fall back on) and fail to resolve.
						// The prefix alias then keeps subpaths — "mithril-lynx/main-thread"
						// and friends, which hold state of their own — on that same copy.
						chain.resolve.alias.set("mithril-lynx$", path.join(selfDir, "src", "lynx-mithril-shim.js"));
						chain.resolve.alias.set("mithril-lynx", selfDir);
					}
				} catch {
					// App doesn't resolve mithril-lynx from its own root (it's being
					// consumed some other way) — leave resolution alone.
				}

				const rawEntries = Object.entries(chain.entryPoints.entries() ?? {});
				chain.entryPoints.clear();

				for (const [name, entry] of rawEntries) {
					const value = entry.values()?.[0];
					const imports = typeof value === "string" || Array.isArray(value) ? value : value?.import;
					const mtSource = Array.isArray(imports) ? imports[0] : imports;
					if (typeof mtSource !== "string") continue;

					const dir = path.dirname(mtSource);
					const bgSource = findSibling(dir, BACKGROUND_CANDIDATES);
					const cssSource = findSibling(dir, STYLE_CANDIDATES);

					const bgEntry = `${name}__background`;
					const mtEntry = `${name}__main-thread`;
					const bgAsset = `.rspeedy/${name}/background.js`;
					const mtAsset = `.rspeedy/${name}/main-thread.js`;
					const hasBackground = bgSource != null;
					// In dev, always materialize a background chunk — even for an app
					// with no background.ts of its own — so live reload's client has
					// somewhere to run. In production, keep the original behavior
					// exactly (no background chunk at all when the app doesn't use one).
					const includeBackground = hasBackground || isDev;

					// Each entry always has main-thread code and may opt into a
					// background thread by adding a sibling background.ts file.
					if (includeBackground) {
						// Imported by its resolved absolute path (plus the query string
						// the client reads its config from) rather than through the bare
						// "mithril-lynx/dev-reload-client" specifier + an alias: the
						// package-wide "mithril-lynx" prefix alias set above matches that
						// specifier first regardless of registration order (webpack/
						// rspack's resolve.alias picks the first matching entry, not the
						// most specific one), which broke the import entirely.
						const bgImports = isDev
							? [
									`${DEV_RELOAD_CLIENT_PATH}?${createDevReloadClientQuery(api, environment, name)}`,
									...(hasBackground ? [bgSource] : []),
								]
							: bgSource;
						chain.entry(bgEntry).add({
							import: bgImports,
							filename: bgAsset,
						});
					}

					chain.entry(mtEntry).add({
						import: cssSource != null ? [mtSource, cssSource] : [mtSource],
						filename: mtAsset,
					});

					chain.plugin(`template-${name}`).use(LynxTemplatePlugin, [
						{
							...LynxTemplatePlugin.defaultOptions,
							filename: `${name}.bundle`,
							intermediate: `.rspeedy/${name}`,
							chunks: includeBackground ? [bgEntry, mtEntry] : [mtEntry],
							dsl: "react_nodiff",
							targetSdkVersion,
							cssPlugins: [],
						},
					]);

					if (includeBackground) {
						// Background chunks run in the JavaScript thread and need the
						// Lynx runtime wrapper; main-thread chunks are encoded as lepus.
						chain.plugin(`runtime-wrapper-${name}`).use(
							RuntimeWrapperWebpackPlugin,
							[
								{
									targetSdkVersion,
									test: new RegExp(`${name}/background\\.js$`),
								},
							],
						);
					}
				}

				chain.plugin("encode").use(LynxEncodePlugin, []);

				chain.plugin("before-encode").use({
					apply(compiler) {
						compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
							// The default grouping only routes a chunk to lepus (main thread)
							// when its asset carries `lynx:main-thread`. These hand-built
							// entries don't, so main-thread JS lands in `manifest` and lepus
							// stays empty. Re-map it here: background JS to manifest, the
							// main-thread chunk to lepus. CSS is already grouped correctly.
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

								// Route tap/gesture events through the refactored main-thread
								// path so `__AddEventListener` handlers fire. This page-config
								// flag was dropped from `@lynx-js/config-rsbuild-plugin` 0.2.0's
								// schema, so set it on the page config directly.
								args.encodeData.sourceContent.config.enableEventHandleRefactor = true;

								args.encodeData.manifest = backgroundAsset
									? {
										[backgroundAsset.name]: backgroundAsset.source
											.source()
											.toString(),
									}
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
