import { describe, expect, it } from "@rstest/core";
import { pluginMithrilLynx } from "../plugin.js";

// Regression guard for the module-duplication trap. The shim keeps its render
// state (rootWrapper/redraw/runRender) in module-level variables, and so do
// main-thread.js and background.js, so an app that bundles two physical copies
// of this package gets two disconnected renderers: the app renders through one
// while any LIBRARY depending on mithril-lynx calls shim.redraw() on the other,
// whose redraw is still null. That's a silent no-op — no error, no log, the UI
// simply never updates. Confirmed on real hardware 2026-09-11.
//
// So this asserts the plugin forces a single copy, the same way it already does
// for `mithril` itself.

/** Minimal ChainConfig stand-in: records aliases, no entries configured. */
function stubChain() {
  const aliases = new Map<string, string>();
  const used: string[] = [];
  return {
    aliases,
    used,
    resolve: { alias: { set: (k: string, v: string) => aliases.set(k, v) } },
    entryPoints: { entries: () => ({}), clear: () => {} },
    entry: () => ({ add: () => {} }),
    plugin: (name: string) => {
      used.push(name);
      return { use: () => {} };
    },
  };
}

function runPlugin() {
  const chain = stubChain();
  let modify: ((c: unknown) => void) | undefined;
  pluginMithrilLynx().setup({
    expose: () => {},
    modifyBundlerChain: (fn: (c: unknown) => void) => {
      modify = fn;
    },
  } as never);
  modify?.(chain);
  return chain;
}

describe("pluginMithrilLynx: single-copy aliasing", () => {
  it("pins the bare specifier to one resolved shim file", () => {
    const { aliases } = runPlugin();

    // Exact-match ($) and pointing at the FILE: aliasing the bare specifier to
    // the package directory would bypass this package's exports map, which has
    // no "main" to fall back on, and fail to resolve at all.
    const bare = aliases.get("mithril-lynx$");
    expect(bare).toBeDefined();
    expect(bare).toMatch(/lynx-mithril-shim\.js$/);
  });

  it("pins subpaths to that same copy", () => {
    const { aliases } = runPlugin();

    // main-thread.js and background.js hold module-level state of their own
    // (latestData, the cross-thread handler maps), so they have to collapse
    // onto one copy too — hence a prefix alias to the package directory
    // alongside the exact one.
    const prefix = aliases.get("mithril-lynx");
    expect(prefix).toBeDefined();
    expect(aliases.get("mithril-lynx$")?.startsWith(prefix as string)).toBe(true);
  });

  it("still pins mithril itself, which has the same failure mode", () => {
    expect(runPlugin().aliases.get("mithril")).toBeDefined();
  });
});
