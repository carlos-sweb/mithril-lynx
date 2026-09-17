// Development-only client for Lynx Go — background thread only.
//
// Adapted from mithril-lynx v1's src/dev-reload-client.js, with the F0
// monkey-patch of `lynx.requireModuleAsync` REMOVED: that patch existed
// only because v1's `RuntimeWrapperWebpackPlugin` config never matched
// `.hot-update.js` chunks, so the native eval context had no `module`/
// `exports` bindings for them (see mithril-lynx-v2-desde-cero.md §F0.2 —
// the real fix is the widened `test` regex in this package's plugin.js,
// applied at build time to every chunk including hot-update ones, not a
// runtime patch of the module loader).
//
// Also REMOVED: the `__mithril_redraw` global v1 called after a successful
// check(). It isn't needed — the app's own background.ts calls
// `module.hot.accept("./index.js", ...)` and re-renders from ITS OWN
// closure when that fires (see the demo app's background.ts for the
// pattern). This client's only job is: decide whether a rebuild can be
// applied via HMR at all, and fall back to a full CDP `Page.reload` when
// it can't (structural changes, `module.hot.decline()`, or a check()
// rejection).
//
// One real fix over v1 that IS new here: the "race de doble-build" (two
// rebuilds landing close together made v1 see `hotStatus !== "idle"` and
// give up to a full reload even though each edit alone was light) is
// fixed by coalescing instead of by a version counter — see
// `pendingRecheckHash` below. `module.hot.check()` itself already refuses
// to run when not idle (real webpack behavior), so the fix has to live on
// this side of that call, not inside it.

var MRL = "[mrl-trace]";

function parseResourceQuery(query) {
	var values = {};
	if (typeof query !== "string" || !query.startsWith("?")) return values;
	for (var i = 0, pairs = query.slice(1).split("&"); i < pairs.length; i++) {
		var pair = pairs[i];
		var index = pair.indexOf("=");
		var key = index === -1 ? pair : pair.slice(0, index);
		var value = index === -1 ? "" : pair.slice(index + 1);
		values[key] = decodeURIComponent(value);
	}
	return values;
}

function socketURL(options) {
	var hostname = options.hostname || "";
	var port = options.port ? ":" + options.port : "";
	var pathname = options.pathname || "/rsbuild-hmr";
	var token = options.token ? "?token=" + encodeURIComponent(options.token) : "";
	return (options.protocol || "ws") + "://" + hostname + port + pathname + token;
}

/**
 * Lynx keys both the HTTP layer and its bytecode cache by URL — a
 * `Page.reload` with the SAME url re-runs the previous bundle byte-for-byte
 * even with `ignoreCache: true` (measured on-device against v1, 0.0.8).
 */
function cacheBustedUrl(url, now) {
	if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return undefined;
	if (now === undefined) now = Date.now();
	var parts = url.split("?");
	var base = parts[0];
	var query = parts[1] || "";
	var params = new URLSearchParams(query);
	params.set("t", String(now));
	return base + "?" + params.toString();
}

var options = parseResourceQuery(__resourceQuery);
var bundleUrl = options["bundle-url"];

console.info(MRL + ":0 client-boot", JSON.stringify({
	hostname: options.hostname,
	port: options.port,
	protocol: options.protocol,
	pathname: options.pathname,
	hasToken: !!options.token,
	bundleUrl: bundleUrl,
}));

var currentHash;
var initialBuild = true;
// Anti-loop guard: without comparing against the hash the running bundle
// was actually built with, every boot would trigger check() for the SAME
// hash it already carries -> manifest 404 -> full reload -> boot -> loop.
var runtimeHash = typeof __webpack_require__ !== "undefined"
	&& typeof __webpack_require__.h === "function"
	? __webpack_require__.h()
	: null;
var socket;
var reloading = false;
// Set when an "ok" for a NEW hash arrives while a check() from a PREVIOUS
// hash is still in flight. Instead of giving up to a full reload (v1's
// race), the in-flight check's `.then`/`.catch` re-drives the check logic
// against this hash once it settles.
var pendingRecheckHash;

function invokeCdpReload() {
	var upperCase = typeof NativeModules !== "undefined" ? NativeModules.LynxDevToolSetModule : undefined;
	var lowerCase = typeof NativeModules !== "undefined" ? NativeModules.LynxDevtoolSetModule : undefined;
	var invokeCdp =
		(upperCase && upperCase.invokeCdp ? upperCase.invokeCdp.bind(upperCase) : undefined) ??
		(typeof (lowerCase && lowerCase.invokeCdp) === "function" ? lowerCase.invokeCdp.bind(lowerCase, "Page.reload") : undefined);
	if (typeof invokeCdp !== "function") return false;

	var params = { ignoreCache: true };
	var url = cacheBustedUrl(bundleUrl);
	if (url != null) params.url = url;

	console.info(MRL + ":9 cdp-page-reload", JSON.stringify({ url: url, bundleUrl: bundleUrl }));

	invokeCdp(
		JSON.stringify({ method: "Page.reload", params }),
		function (data) {
			if (!data) return;
			try {
				var parsed = JSON.parse(data);
				if (parsed.error) console.error("[mithril-lynx-v2] Page.reload failed:", parsed.error.message);
			} catch (e) {
				// response is not JSON — ignore
			}
		},
	);
	return true;
}

function reload(reason) {
	console.info(MRL + ":8 reload-called", JSON.stringify({ reason: reason || "unspecified" }));
	reloading = true;
	if (socket) socket.close();
	if (!invokeCdpReload()) {
		console.warn(
			"[mithril-lynx-v2] Live reload unavailable: NativeModules.LynxDevToolSetModule.invokeCdp was not found.",
		);
	}
}

function runCheck(hash) {
	console.info(MRL + ":5 hmr-check-calling", "module.hot.check(true)");
	module.hot.check(true).then(function (updatedModules) {
		console.info(MRL + ":6 hmr-check-resolved", JSON.stringify({
			updatedModulesLength: updatedModules ? updatedModules.length : 0,
		}));
		var recheck = pendingRecheckHash;
		pendingRecheckHash = undefined;
		if (recheck && recheck !== hash) {
			console.info(MRL + ":6d coalesced-recheck", JSON.stringify({ hash: recheck }));
			maybeCheck(recheck);
			return;
		}
		if (!updatedModules || updatedModules.length === 0) {
			console.info(MRL + ":6c hmr-no-modules", "falling back to full reload");
			reload("hmr-check-returned-no-modules");
		}
	}).catch(function (err) {
		console.warn(MRL + ":7 hmr-check-rejected", JSON.stringify({
			message: err && err.message,
		}));
		var recheck = pendingRecheckHash;
		pendingRecheckHash = undefined;
		if (recheck) {
			maybeCheck(recheck);
			return;
		}
		reload("hmr-check-rejected:" + (err && err.message ? err.message : String(err)));
	});
}

function maybeCheck(hash) {
	var hasHot = typeof module !== "undefined" && module.hot;
	var hotStatus = hasHot ? module.hot.status() : "n/a";

	console.info(MRL + ":4 hmr-check", JSON.stringify({ hasModuleHot: hasHot, hotStatus: hotStatus }));

	if (!hasHot) {
		console.info(MRL + ":4a hmr-unavailable", JSON.stringify({ hasHot: hasHot }));
		reload("hmr-unavailable:no-module-hot");
		return;
	}
	if (hotStatus !== "idle") {
		// A check for an OLDER hash is still in flight — coalesce instead of
		// bailing to a full reload (the v1 "race de doble-build" fix).
		pendingRecheckHash = hash;
		console.info(MRL + ":4b hmr-check-in-flight", JSON.stringify({ queuedHash: hash }));
		return;
	}
	runCheck(hash);
}

function handleMessage(rawMessage) {
	var message;
	try {
		message = JSON.parse(rawMessage);
	} catch (e) {
		console.warn("[mithril-lynx-v2] Ignoring an invalid dev-server message.");
		return;
	}

	switch (message.type) {
		case "hash":
			currentHash = message.data;
			console.info(MRL + ":2a hash-received", JSON.stringify({ hash: message.data }));
			break;
		case "ok":
			console.info(MRL + ":3 ok-received", JSON.stringify({ initialBuild: initialBuild }));
			if (initialBuild) {
				initialBuild = false;
				console.info(MRL + ":3a initial-build-skipped");
			} else if (currentHash) {
				if (runtimeHash && currentHash === runtimeHash) {
					console.info(MRL + ":3b hash-equal-same-build");
					break;
				}
				maybeCheck(currentHash);
			}
			break;
		case "warnings":
			if (!message.params || !message.params.preventReloading) {
				if (!initialBuild) reload("build-warnings");
			}
			break;
		case "errors":
			console.warn("[mithril-lynx-v2] Build failed; waiting for the next successful build.", message.data);
			break;
	}
}

function connect(retries) {
	if (retries === undefined) retries = 0;
	console.info(MRL + ":1 ws-connecting", JSON.stringify({ url: socketURL(options), retry: retries }));

	socket = new WebSocket(socketURL(options));
	socket.onmessage = function (event) { handleMessage(event.data); };
	socket.onerror = function (error) { console.error("[mithril-lynx-v2] Dev server connection error:", error); };
	socket.onclose = function () {
		if (reloading) return;
		if (retries >= 10) {
			console.error("[mithril-lynx-v2] Unable to reconnect to the dev server.");
			return;
		}
		var delay = 1000 * Math.pow(2, retries) + Math.random() * 100;
		setTimeout(function () { connect(retries + 1); }, delay);
	};
}

connect();
