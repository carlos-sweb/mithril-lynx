import { defineConfig } from "@rstest/core";

export default defineConfig({
	testEnvironment: "jsdom",
	setupFiles: [
		"./test/setup.ts",
		"@lynx-js/testing-environment/env/rstest",
	],
	globals: true,
	include: ["test/**/*.test.ts"],
	tools: {
		rspack: {
			module: {
				rules: [
					// src/ is CommonJS-shaped in a "type": "module" package in a
					// couple of places (none yet as of F1, kept for parity with
					// v1's config in case a future file needs it) — see
					// mithril-lynx/rstest.config.ts for the original rationale.
					{
						test: /\/src\/.*\.cjs$/,
						type: "javascript/dynamic",
					},
				],
			},
		},
	},
});
