// src/reload/version.js
//
// Race guard for concurrent hot-updates (method A/B, reload/hot-accept.js).
// v1 had this bug for real: two rebuilds landing close together made the
// dev client see a `module.hot.check()` still in flight and degrade to a
// full reload EVEN THOUGH each edit individually would have been light
// (mithril-lynx/.omo/plans/arquitectura-dual-reload.md, F1 "race de
// doble-build"). ReactLynx doesn't avoid the race with a status flag at
// all — it lets both builds' patches land in whatever order they arrive,
// and discards any patch whose `reloadVersion` is older than the current
// one (rspeedy-react-analysis/LYNX_PAPI_SPEC.md §5.1). This is that same
// counter, adopted directly rather than re-deriving a flag-based guard.

let version = 0;

export function getReloadVersion() {
	return version;
}

export function increaseReloadVersion() {
	return ++version;
}

/** True if a patch stamped with `patchVersion` is stale and must be
 * dropped without being applied — the ENTIRE guard, one comparison. */
export function isStaleVersion(patchVersion) {
	return typeof patchVersion === "number" && patchVersion < version;
}
