import { describe, expect, it } from "@rstest/core";
import { cacheBustedUrl, pickReloadTarget } from "../plugin.js";

// Unit tests for the pure half of live reload: deciding WHICH Lynx session a
// rebuild should reload.
//
// The interesting cases are all "more than one candidate", because getting this
// wrong reloads somebody else's page:
//   - Lynx Go's own shell page is itself a Lynx session and is usually the
//     newest one, so "just take the highest session_id" would reload the shell.
//   - A second Lynx app (or a second attached device) can be newer than ours.
//
// The device-touching half (listClients/sendCDPMessage) is deliberately not
// covered here — it needs real hardware, and is verified on-device instead.

function client(id) {
  return { id, info: {} };
}

function session(sessionId, url, type = "lynx") {
  return { session_id: sessionId, type, url };
}

describe("pickReloadTarget", () => {
  it("ignores the viewer's own shell page even when it is the newest session", () => {
    const target = pickReloadTarget(
      [
        {
          client: client("c1"),
          sessions: [session(1, "http://192.0.2.10:3000/main.bundle"), session(99, "homepage.lynx.bundle")],
        },
      ],
      { bundleHints: ["main.bundle"] },
    );

    expect(target).toEqual({ clientId: "c1", sessionId: 1, url: "http://192.0.2.10:3000/main.bundle" });
  });

  it("recognizes the shell by its basename, not by an exact string match", () => {
    // The shell shows up both bare and as a full URL depending on the client.
    const target = pickReloadTarget(
      [
        {
          client: client("c1"),
          sessions: [session(5, "http://192.0.2.10:3000/homepage.lynx.bundle?fullscreen=true")],
        },
      ],
      { bundleHints: ["main.bundle"] },
    );

    expect(target).toBeNull();
  });

  it("prefers a session serving one of this app's bundles over a newer unrelated one", () => {
    const target = pickReloadTarget(
      [
        {
          client: client("c1"),
          sessions: [
            session(1, "http://192.0.2.10:3000/main-thread.bundle"),
            // Another Lynx app, opened later, on the same device.
            session(42, "http://192.0.2.10:3000/other-app.bundle"),
          ],
        },
      ],
      { bundleHints: ["main-thread.bundle"] },
    );

    expect(target?.sessionId).toBe(1);
  });

  it("falls back to the newest lynx session when no hint matches", () => {
    const target = pickReloadTarget(
      [
        {
          client: client("c1"),
          sessions: [session(3, "http://192.0.2.10:3000/a.bundle"), session(7, "http://192.0.2.10:3000/b.bundle")],
        },
      ],
      { bundleHints: ["main-thread.bundle"] },
    );

    expect(target?.sessionId).toBe(7);
  });

  it("skips non-lynx sessions", () => {
    const target = pickReloadTarget(
      [
        {
          client: client("c1"),
          sessions: [session(9, "https://example.com", "web"), session(2, "http://192.0.2.10:3000/main.bundle", "lynx")],
        },
      ],
      { bundleHints: ["main.bundle"] },
    );

    expect(target?.sessionId).toBe(2);
  });

  it("picks the newest session across several clients", () => {
    const target = pickReloadTarget(
      [
        { client: client("c1"), sessions: [session(2, "http://192.0.2.10:3000/main.bundle")] },
        { client: client("c2"), sessions: [session(8, "http://192.0.2.11:3000/main.bundle")] },
      ],
      { bundleHints: ["main.bundle"] },
    );

    expect(target).toEqual({ clientId: "c2", sessionId: 8, url: "http://192.0.2.11:3000/main.bundle" });
  });

  it("returns null when there is nothing to reload", () => {
    expect(pickReloadTarget([])).toBeNull();
    expect(pickReloadTarget([{ client: client("c1"), sessions: [] }])).toBeNull();
    expect(pickReloadTarget([{ client: client("c1"), sessions: [session(1, "homepage.lynx.bundle")] }])).toBeNull();
  });

  it("tolerates a client whose session listing came back empty or missing", () => {
    expect(pickReloadTarget([{ client: client("c1"), sessions: undefined }])).toBeNull();
    expect(pickReloadTarget([{ client: client("c1"), sessions: null }])).toBeNull();
  });

  it("does not blow up on a session with no url", () => {
    const target = pickReloadTarget(
      [{ client: client("c1"), sessions: [session(1, undefined), session(4, "http://192.0.2.10:3000/main.bundle")] }],
      { bundleHints: ["main.bundle"] },
    );

    expect(target?.sessionId).toBe(4);
  });
});

describe("cacheBustedUrl", () => {
  // Measured on-device: reloading without a changed URL re-ran the PREVIOUS
  // bundle even with ignoreCache:true — the old text stayed on screen and the
  // loaded template was byte-for-byte the previous build. Both the HTTP layer
  // and Lynx's bytecode cache key on the URL, so this is what actually makes a
  // reload pick up new code.

  it("adds a unique parameter to a plain bundle url", () => {
    expect(cacheBustedUrl("http://10.0.2.2:3000/main.bundle", 1234)).toBe("http://10.0.2.2:3000/main.bundle?t=1234");
  });

  it("preserves an existing query string", () => {
    expect(cacheBustedUrl("http://10.0.2.2:3000/main.bundle?fullscreen=true", 42)).toBe(
      "http://10.0.2.2:3000/main.bundle?fullscreen=true&t=42",
    );
  });

  it("overwrites a previous cache-busting parameter instead of stacking them", () => {
    const once = cacheBustedUrl("http://10.0.2.2:3000/main.bundle", 1);
    const twice = cacheBustedUrl(once, 2);

    expect(twice).toBe("http://10.0.2.2:3000/main.bundle?t=2");
  });

  it("returns undefined for anything Page.reload would reject", () => {
    // Page.reload requires an http(s) url; the caller then omits the param.
    expect(cacheBustedUrl("homepage.lynx.bundle")).toBeUndefined();
    expect(cacheBustedUrl("asset:///fonts/x.ttf")).toBeUndefined();
    expect(cacheBustedUrl("file:///tmp/main.bundle")).toBeUndefined();
    expect(cacheBustedUrl("")).toBeUndefined();
    expect(cacheBustedUrl(undefined)).toBeUndefined();
  });

  it("accepts https", () => {
    expect(cacheBustedUrl("https://example.com/main.bundle", 9)).toBe("https://example.com/main.bundle?t=9");
  });
});
