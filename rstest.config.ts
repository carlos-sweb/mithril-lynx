import { defineConfig } from "@rstest/core";

export default defineConfig({
  testEnvironment: "jsdom",
  setupFiles: [
    // Set the PAPI polyfill hook before the testing environment installs.
    "./test/setup.ts",
    "@lynx-js/testing-environment/env/rstest",
  ],
  globals: true,
  include: ["test/**/*.test.ts"],
  tools: {
    rspack: {
      module: {
        rules: [
          {
            // src/ is CommonJS (require + module.exports), but Rspack treats
            // .js files in a "type": "module" package as ESM. Force CommonJS
            // handling so `module.exports` and static `require()` calls work.
            test: /\/src\/.*\.js$/,
            type: "javascript/dynamic",
          },
        ],
      },
    },
  },
});
