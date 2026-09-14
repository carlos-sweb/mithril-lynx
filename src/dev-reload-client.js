// Development-only client for Lynx Go.
//
// Mithril view code runs in the main-thread/Lepus bundle, while WebSocket and
// Native Module access only exist in the background JS bundle. Consequently
// normal module HMR cannot patch the view code. On a successful rebuild this
// client asks Lynx Go's ExplorerModule to load the same bundle URL again.

function parseResourceQuery(query) {
	const values = {};
	if (typeof query !== "string" || !query.startsWith("?")) return values;
	for (const pair of query.slice(1).split("&")) {
		const index = pair.indexOf("=");
		const key = index === -1 ? pair : pair.slice(0, index);
		const value = index === -1 ? "" : pair.slice(index + 1);
		values[key] = decodeURIComponent(value);
	}
	return values;
}

function socketURL(options) {
	const hostname = options.hostname || "";
	const port = options.port ? `:${options.port}` : "";
	const pathname = options.pathname || "/rsbuild-hmr";
	const token = options.token ? `?token=${encodeURIComponent(options.token)}` : "";
	return `${options.protocol || "ws"}://${hostname}${port}${pathname}${token}`;
}

const options = parseResourceQuery(__resourceQuery);
const bundleUrl = options["bundle-url"];
let currentHash;
let initialBuild = true;
let socket;
// ExplorerModule.openSchema(url) makes Lynx Go fully reload — including
// re-executing this very module from scratch. That would naturally replace
// this stale instance's socket with a fresh one, except the OLD connection
// is otherwise left open: confirmed on-device that every earlier reload's
// socket stays alive and keeps receiving server broadcasts, so a build a few
// reloads in fires openSchema several times at once (one call per still-open
// stale socket), and the resulting navigations race and clobber each other —
// only the first reload after a fresh QR/URL load (a single open socket)
// reliably lands. Closing this socket ourselves right before reloading, and
// suppressing the reconnect-on-close it would otherwise trigger, keeps
// exactly one socket alive at a time.
let reloading = false;

console.info(
	"[mithril-lynx] ExplorerModule.openSchema:",
	typeof NativeModules !== "undefined" && typeof NativeModules.ExplorerModule?.openSchema,
);

function reload() {
	const openSchema =
		typeof NativeModules !== "undefined" && NativeModules.ExplorerModule?.openSchema;
	if (typeof openSchema !== "function") {
		console.warn("[mithril-lynx] Live reload unavailable: ExplorerModule.openSchema was not found.");
		return;
	}
	if (!bundleUrl) {
		console.warn("[mithril-lynx] Live reload unavailable: the bundle URL was not configured.");
		return;
	}
	console.info("[mithril-lynx] Reloading updated bundle.");
	reloading = true;
	socket?.close();
	openSchema.call(NativeModules.ExplorerModule, bundleUrl);
}

function handleMessage(rawMessage) {
	let message;
	try {
		message = JSON.parse(rawMessage);
	} catch {
		console.warn("[mithril-lynx] Ignoring an invalid dev-server message.");
		return;
	}

	switch (message.type) {
		case "hash":
			currentHash = message.data;
			break;
		case "ok":
			// The server sends hash + ok immediately after connecting. Reloading
			// then would loop forever, so only act after a later successful build.
			if (initialBuild) initialBuild = false;
			else if (currentHash) reload();
			break;
		case "still-ok":
			console.info("[mithril-lynx] Nothing changed.");
			break;
		case "warnings":
			console.warn("[mithril-lynx] Build completed with warnings.", message.data);
			if (!message.params?.preventReloading && !initialBuild) reload();
			break;
		case "errors":
			console.warn("[mithril-lynx] Build failed; waiting for the next successful build.", message.data);
			break;
		case "invalid":
			console.info("[mithril-lynx] App updated. Recompiling...");
			break;
		case "error":
			console.error("[mithril-lynx] Dev server error:", message.data);
			break;
	}
}

function connect(retries = 0) {
	socket = new WebSocket(socketURL(options));
	socket.onmessage = (event) => handleMessage(event.data);
	socket.onerror = (error) => console.error("[mithril-lynx] Dev server connection error:", error);
	socket.onclose = () => {
		if (reloading) return; // Deliberately closed by reload() — a fresh socket is on its way already.
		if (retries >= 10) {
			console.error("[mithril-lynx] Unable to reconnect to the dev server.");
			return;
		}
		const delay = 1000 * 2 ** retries + Math.random() * 100;
		console.info("[mithril-lynx] Dev server disconnected; reconnecting...");
		setTimeout(() => connect(retries + 1), delay);
	};
}

connect();
