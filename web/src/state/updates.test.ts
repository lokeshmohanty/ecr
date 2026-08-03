import { describe, expect, it } from "vitest";

import { checkForUpdate, isNewer, parseVersion, pickApk, readRelease } from "./updates";

function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: "v0.1.3",
    html_url: "https://github.com/lokeshmohanty/ecr/releases/tag/v0.1.3",
    assets: [
      {
        name: "app-universal-release.apk",
        browser_download_url: "https://example.test/app-universal-release.apk",
      },
    ],
    ...overrides,
  };
}

function answers(body: unknown, init: { ok?: boolean; status?: number } = {}): typeof fetch {
  return (async () =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    }) as Response) as typeof fetch;
}

describe("parseVersion", () => {
  it("reads a tag with or without its v", () => {
    expect(parseVersion("v0.1.2")).toEqual([0, 1, 2]);
    expect(parseVersion("0.1.2")).toEqual([0, 1, 2]);
    expect(parseVersion(" 1.20.300 ")).toEqual([1, 20, 300]);
  });

  it("refuses anything that is not three numbers", () => {
    expect(parseVersion("nightly")).toBeNull();
    expect(parseVersion("0.1")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("isNewer", () => {
  it("compares numerically, not as text", () => {
    // The whole reason the tag is parsed: "0.1.10" < "0.1.9" as a string.
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("0.1.9", "0.1.10")).toBe(false);
  });

  it("holds across each position", () => {
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.2.0", "0.1.99")).toBe(true);
    expect(isNewer("0.1.2", "0.1.2")).toBe(false);
    expect(isNewer("0.1.1", "0.1.2")).toBe(false);
  });

  it("says it cannot tell rather than guessing", () => {
    expect(isNewer("main", "0.1.2")).toBeNull();
    expect(isNewer("0.1.3", "unknown")).toBeNull();
  });
});

describe("pickApk", () => {
  it("prefers the universal build over a per-ABI one", () => {
    const url = pickApk([
      { name: "app-arm64-release.apk", browser_download_url: "https://example.test/arm64.apk" },
      { name: "app-universal-release.apk", browser_download_url: "https://example.test/all.apk" },
    ]);

    expect(url).toBe("https://example.test/all.apk");
  });

  it("never offers an unsigned APK", () => {
    // v0.1.1 shipped one. It cannot be installed over a signed build, so
    // offering it would break a working install rather than update it.
    expect(
      pickApk([
        {
          name: "app-universal-release-unsigned.apk",
          browser_download_url: "https://example.test/unsigned.apk",
        },
      ]),
    ).toBeNull();
  });

  it("ignores the bundle and the checksums", () => {
    expect(
      pickApk([
        { name: "app-universal-release.aab", browser_download_url: "https://example.test/a.aab" },
        { name: "SHA256SUMS", browser_download_url: "https://example.test/SHA256SUMS" },
      ]),
    ).toBeNull();
  });

  it("survives an answer with no assets at all", () => {
    expect(pickApk(undefined)).toBeNull();
    expect(pickApk([])).toBeNull();
  });
});

describe("readRelease", () => {
  it("drops the leading v from the version it reports", () => {
    expect(readRelease(release())?.version).toBe("0.1.3");
  });

  it("falls back to the releases page when the answer carries no link", () => {
    const read = readRelease(release({ html_url: 42 }));
    expect(read?.page).toBe("https://github.com/lokeshmohanty/ecr/releases/latest");
  });

  it("refuses an answer with no readable tag", () => {
    expect(readRelease(release({ tag_name: "nightly" }))).toBeNull();
    expect(readRelease({})).toBeNull();
    expect(readRelease(null)).toBeNull();
  });
});

describe("checkForUpdate", () => {
  it("reports the release when it is newer", async () => {
    const state = await checkForUpdate("0.1.2", answers(release()));

    expect(state).toEqual({
      kind: "available",
      release: {
        version: "0.1.3",
        apk: "https://example.test/app-universal-release.apk",
        page: "https://github.com/lokeshmohanty/ecr/releases/tag/v0.1.3",
      },
    });
  });

  it("says so when this is already the newest", async () => {
    expect(await checkForUpdate("0.1.3", answers(release()))).toEqual({
      kind: "current",
      version: "0.1.3",
    });
  });

  it("does not offer to downgrade a build ahead of the release", async () => {
    // A local build carries a version that is not out yet.
    expect(await checkForUpdate("0.2.0", answers(release()))).toEqual({
      kind: "current",
      version: "0.1.3",
    });
  });

  it("reports an update as available even when there is nothing to download", async () => {
    const state = await checkForUpdate("0.1.2", answers(release({ assets: [] })));

    expect(state.kind).toBe("available");
    expect(state.kind === "available" && state.release.apk).toBeNull();
  });

  it("reports a refusal from GitHub rather than staying silent", async () => {
    const state = await checkForUpdate("0.1.2", answers(null, { ok: false, status: 403 }));

    expect(state).toEqual({ kind: "failed", reason: "GitHub answered 403" });
  });

  it("reports a network that is not there", async () => {
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    expect(await checkForUpdate("0.1.2", offline)).toEqual({
      kind: "failed",
      reason: "could not reach GitHub",
    });
  });

  it("reports an answer it cannot read", async () => {
    const state = await checkForUpdate("0.1.2", answers({ tag_name: "main" }));

    expect(state).toEqual({ kind: "failed", reason: "GitHub answered something unreadable" });
  });

  it("reports an installed version it cannot compare", async () => {
    const state = await checkForUpdate("dev", answers(release()));

    expect(state).toEqual({ kind: "failed", reason: "cannot compare dev with 0.1.3" });
  });
});
