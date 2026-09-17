import { describe, expect, it } from "@rstest/core";
import { getReloadVersion, increaseReloadVersion, isStaleVersion } from "../src/reload/version.js";

describe("reload version guard (replaces v1's hotStatus race-prone flag)", () => {
	it("discards a patch stamped with an older version than the current one", () => {
		const v1 = getReloadVersion();
		expect(isStaleVersion(v1)).toBe(false); // not stale yet, nothing bumped

		increaseReloadVersion();
		// A patch built before this reload (stamped with the old version)
		// must now be treated as stale — this is the exact scenario of the
		// v1 "race de doble-build": two builds in flight, the older one's
		// patch must lose without needing a status flag at all.
		expect(isStaleVersion(v1)).toBe(true);
		expect(isStaleVersion(getReloadVersion())).toBe(false);
	});
});
