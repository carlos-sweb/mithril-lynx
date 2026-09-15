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

// ---------------------------------------------------------------------------
// Live reload (dev only)
//
// How a rebuild reaches the device, and why it works this way:
//
// - Real module HMR cannot help here at all. Mithril view code lives in the
//   main-thread/Lepus chunk, and rspack's hot runtime can only patch modules in
//   the registry it runs from — the background/JS thread. That is an
//   architectural mismatch, not a bug to fix.
// - A CDP command the bundle sends to *itself*
//   (NativeModules.LynxDevToolSetModule.invokeCdp) is a silent no-op: there is
//   no external DevTool session behind it.
// - ExplorerModule.openSchema(url) — what 0.0.7 shipped — works, but it is a
//   real navigation: Lynx Go starts a NEW LynxViewShellActivity every time and
//   never finishes the one it replaces, so Back then steps through one frozen
//   snapshot per reload.
// - Page.reload from an *external* DevTool session reloads the existing page in
//   place (the DevTools reference notes the session URL is unchanged after it),
//   so nothing new is pushed onto the back stack.
//
// So this runs from the Node dev-server process rather than from a chunk
// bundled into the app, and no synthetic background entry is needed.
//
// The trade-off: the DevTool connector reaches the device through adb, so live
// reload needs the device connected over adb. openSchema could work over Wi-Fi
// alone, but only by corrupting the back stack.
// ---------------------------------------------------------------------------

/** Lynx Go's own shell page is a Lynx session too — never a reload target. */
const VIEWER_SHELL_BUNDLE = "homepage.lynx.bundle";

let connectorPromise;
let devtoolTransport;

/**
 * Lazily loads the DevTool connector. Kept lazy so `@lynx-js/devtool-connector`
 * is only ever loaded by a dev rebuild, never by a production build.
 */
function getDevtoolConnector() {
	if (!connectorPromise) {
		connectorPromise = Promise.all([
			import("@lynx-js/devtool-connector"),
			import("@lynx-js/devtool-connector/transport"),
		])
			.then(([{ Connector }, { AndroidTransport }]) => {
				devtoolTransport = new AndroidTransport();
				return new Connector([devtoolTransport]);
			})
			.catch((error) => {
				// Don't cache a rejection: the usual cause is the package not
				// being installed yet, and the dev server outlives an
				// `npm install`.
				connectorPromise = undefined;
				throw error;
			});
	}
	return connectorPromise;
}

/** Last path segment of a URL, ignoring any query string or fragment. */
function bundleBasename(url) {
	if (typeof url !== "string") return "";
	const withoutQuery = url.split("?")[0].split("#")[0];
	const segments = withoutQuery.split("/");
	return segments[segments.length - 1] || withoutQuery;
}

function isViewerShell(url) {
	return bundleBasename(url) === VIEWER_SHELL_BUNDLE;
}

/**
 * Adds a unique query parameter to a bundle URL.
 *
 * `Page.reload` on its own is not enough to pick up a rebuild: measured
 * on-device, a reload without this re-fetched and re-ran the PREVIOUS bundle
 * (the loaded template stayed byte-for-byte the old one, and the old text
 * stayed on screen) even with `ignoreCache: true`. Both the HTTP layer and
 * Lynx's own bytecode cache are keyed by URL, so changing the URL is what
 * actually invalidates them. The session's own URL is unaffected — the DevTools
 * reference notes it does not change after a reload, and that was confirmed
 * here too.
 *
 * Returns undefined for anything that isn't an http(s) URL, in which case the
 * caller lets Page.reload use the URL it already has (it rejects anything else).
 */
export function cacheBustedUrl(url, now = Date.now()) {
	if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return undefined;
	const [base, query = ""] = url.split("?");
	const params = new URLSearchParams(query);
	params.set("t", String(now));
	return `${base}?${params.toString()}`;
}

function matchesHint(url, hints) {
	if (typeof url !== "string" || hints.length === 0) return false;
	return hints.some((hint) => url.includes(hint));
}

/**
 * Chooses which client/session to reload: `targets` is `[{ client, sessions }]`,
 * returns `{ clientId, sessionId, url }` or null.
 *
 * Pure and exported so it can be tested without a device attached.
 */
export function pickReloadTarget(targets, { bundleHints = [] } = {}) {
	const candidates = [];
	for (const { client, sessions } of targets) {
		for (const session of sessions ?? []) {
			if (session?.type !== "lynx") continue;
			if (isViewerShell(session.url)) continue;
			candidates.push({ clientId: client.id, session });
		}
	}
	if (candidates.length === 0) return null;

	// Prefer the session actually serving one of this app's bundles over
	// "whatever was opened most recently": with a second Lynx app, or a second
	// attached device, the newest session need not be ours.
	const preferred = candidates.filter((candidate) => matchesHint(candidate.session.url, bundleHints));
	const pool = preferred.length > 0 ? preferred : candidates;

	const latest = pool.reduce((a, b) => (b.session.session_id > a.session.session_id ? b : a));
	return {
		clientId: latest.clientId,
		sessionId: latest.session.session_id,
		url: latest.session.url,
	};
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listClientSessions(connector) {
	const clients = await connector.listClients();
	const targets = [];
	for (const client of clients) {
		try {
			targets.push({ client, sessions: await connector.sendListSessionMessage(client.id) });
		} catch {
			// This client doesn't support session listing, or isn't ready yet.
		}
	}
	return targets;
}

/**
 * Finds a session worth reloading, retrying briefly: on the very first rebuild
 * the DevTool client may not have registered with the device yet.
 */
async function findReloadTarget(bundleHints, { attempts = 3, delayMs = 400 } = {}) {
	const connector = await getDevtoolConnector();
	for (let attempt = 0; attempt < attempts; attempt++) {
		const target = pickReloadTarget(await listClientSessions(connector), { bundleHints });
		if (target) return { connector, target };
		if (attempt < attempts - 1) await sleep(delayMs);
	}
	return { connector, target: null };
}

/**
 * Reloads the running page in place. Returns true when a session was reloaded,
 * false when none was found (the caller logs that).
 */
async function reloadViaDevtool(bundleHints) {
	const { connector, target } = await findReloadTarget(bundleHints);
	if (!target) return false;

	const params = { ignoreCache: true };
	// Without a changed URL the device replays its cached copy of the previous
	// bundle — see cacheBustedUrl(). The session URL itself does not change.
	const url = cacheBustedUrl(target.url);
	if (url != null) params.url = url;

	await connector.sendCDPMessage(target.clientId, target.sessionId, "Page.reload", params);
	console.info(
		`[mithril-lynx] Reloaded ${target.url || "(url unknown)"} (session ${target.sessionId}${url != null ? "" : ", no cache-busting: non-http url"}).`,
	);
	return true;
}

/** Releases the adb connection when the dev server goes away. */
async function closeDevtoolTransport() {
	const transport = devtoolTransport;
	devtoolTransport = undefined;
	connectorPromise = undefined;
	await transport?.close?.();
}

/** Turns a connector failure into an actionable one-liner. */
function describeReloadFailure(error) {
	if (error?.code === "ERR_MODULE_NOT_FOUND" || /devtool-connector/.test(error?.message ?? "")) {
		return "Live reload is off: @lynx-js/devtool-connector is not installed. Run `npm install @lynx-js/devtool-connector`, then restart the dev server.";
	}
	return `Live reload unavailable: ${error instanceof Error ? error.message : String(error)}`;
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
	const liveReload = options.liveReload ?? true;

	// Filled in by modifyBundlerChain below with "<entry>.bundle" for every
	// configured entry, so a reload prefers the session actually serving this
	// app over whichever Lynx session happens to be newest.
	const bundleHints = new Set();

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
			// Force dev.hmr off (unless the app explicitly set it) -- real HMR
			// can't reach this framework's app code regardless of how reload
			// itself is triggered (see reloadViaDevtool() above), so leaving it
			// on only adds that error noise for no benefit.
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

			// Live reload itself: on every successful dev rebuild (skipping the
			// first, which is the initial build rather than an edit), find the
			// running Lynx session and CDP-reload it in place. See the block
			// above reloadViaDevtool() for why this runs from here (the Node
			// dev-server process) instead of from a chunk bundled into the app.
			if (liveReload) {
				api.onAfterDevCompile(async ({ isFirstCompile, stats }) => {
					if (isFirstCompile || stats.hasErrors()) return;
					let reloaded = false;
					try {
						reloaded = await reloadViaDevtool([...bundleHints]);
					} catch (error) {
						console.warn(`[mithril-lynx] ${describeReloadFailure(error)}`);
						return;
					}
					if (!reloaded) {
						console.warn(
							"[mithril-lynx] Live reload unavailable: no Lynx session found for this app. " +
								"Is the device connected over adb with the page open in Lynx Go? Reload manually.",
						);
					}
				});

				// The transport owns adb port-forwards; don't let them outlive
				// the dev server.
				api.onCloseDevServer?.(closeDevtoolTransport);
			}

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

					// The bundle this entry produces is always "<name>.bundle"
					// (the filename above), and a loaded session's URL ends with
					// it — that is what lets a reload pick out this app's session.
					bundleHints.add(`${name}.bundle`);

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
