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

import { RuntimeWrapperWebpackPlugin } from "@lynx-js/runtime-wrapper-webpack-plugin";
import { LynxEncodePlugin, LynxTemplatePlugin } from "@lynx-js/template-webpack-plugin";

const PLUGIN_NAME = "mithril-lynx-template-webpack";

const BACKGROUND_CANDIDATES = ["background.ts", "background.js"];
const STYLE_CANDIDATES = ["style.css"];

function findSibling(dir, candidates) {
	for (const name of candidates) {
		const candidate = path.join(dir, name);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

export function pluginMithrilLynx(options = {}) {
	const targetSdkVersion = options.targetSdkVersion ?? "3.5";

	return {
		name: PLUGIN_NAME,
		setup(api) {
			// Keep the template plugin discoverable by Rspeedy's Lynx internals.
			api.expose(Symbol.for("LynxTemplatePlugin"), { LynxTemplatePlugin });
			api.modifyBundlerChain((chain) => {
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

					// Each entry always has main-thread code and may opt into a
					// background thread by adding a sibling background.ts file.
					if (hasBackground) {
						chain.entry(bgEntry).add({
							import: bgSource,
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
							chunks: hasBackground ? [bgEntry, mtEntry] : [mtEntry],
							dsl: "react_nodiff",
							targetSdkVersion,
							cssPlugins: [],
						},
					]);

					if (hasBackground) {
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
