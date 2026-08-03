/**
 * Whether a newer APK has been released, asked once, when someone asks.
 *
 * This exists only for the Android build, and only because that build is
 * sideloaded: a desktop install comes from a package manager and the browser
 * client is whatever the server is serving, so both already update themselves.
 * An APK someone downloaded once has no way of knowing it has been superseded.
 *
 * It checks and then hands over the download — it does not install anything.
 * Fetching an APK and firing an install intent would need
 * `REQUEST_INSTALL_PACKAGES` and a FileProvider; handing the URL to the browser
 * reaches the same system installer with nothing new in the manifest.
 *
 * Nothing here runs on a timer. The unauthenticated GitHub API allows 60
 * requests an hour per address, which is generous for a button and not for a
 * poll, and a mail client checking a code host in the background is a surprise
 * to whoever is watching the network.
 */

/** The one release this app can be an older version of. */
export const RELEASES_URL =
  "https://api.github.com/repos/lokeshmohanty/ecr/releases/latest";

export type Release = {
  version: string;
  /** The download, or null when the release carries no APK worth offering. */
  apk: string | null;
  page: string;
};

export type UpdateState =
  | { kind: "unchecked" }
  | { kind: "checking" }
  | { kind: "current"; version: string }
  | { kind: "available"; release: Release }
  | { kind: "failed"; reason: string };

/**
 * `0.1.2` or `v0.1.2` as numbers, or null for anything else.
 *
 * A tag is compared as three integers, never as text: `0.1.10` sorts before
 * `0.1.9` as a string, and that is exactly the comparison an update check must
 * not get wrong. Anything after the patch number — a `-rc1` — is deliberately
 * ignored rather than parsed, because this repository does not publish
 * prereleases and guessing at an ordering for them would be inventing one.
 */
export function parseVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `candidate` is a later version than `installed`; null if either is unreadable. */
export function isNewer(candidate: string, installed: string): boolean | null {
  const a = parseVersion(candidate);
  const b = parseVersion(installed);
  if (!a || !b) return null;

  const [major, minor, patch] = a;
  const [wasMajor, wasMinor, wasPatch] = b;
  if (major !== wasMajor) return major > wasMajor;
  if (minor !== wasMinor) return minor > wasMinor;
  return patch > wasPatch;
}

type Asset = { name?: unknown; browser_download_url?: unknown };

/**
 * The APK to offer out of a release's assets.
 *
 * An `-unsigned.apk` is skipped rather than offered. v0.1.1 shipped one, and an
 * unsigned APK cannot be installed over a signed one — pointing someone at it
 * would replace a working app with a failed install and no way back but
 * uninstalling. A release with nothing else is a release with no download.
 */
export function pickApk(assets: unknown): string | null {
  if (!Array.isArray(assets)) return null;

  const named = assets.filter((asset: Asset) => {
    const name = typeof asset?.name === "string" ? asset.name : "";
    const url = typeof asset?.browser_download_url === "string";
    return url && name.endsWith(".apk") && !name.includes("-unsigned");
  }) as { name: string; browser_download_url: string }[];

  // The universal APK carries every ABI, so it is the one that runs on whatever
  // phone is asking. A per-ABI build would be a guess from here.
  const universal = named.find((asset) => asset.name.includes("universal"));
  return (universal ?? named[0])?.browser_download_url ?? null;
}

/** A release out of the API's answer, or null when it is not one. */
export function readRelease(body: unknown): Release | null {
  if (typeof body !== "object" || body === null) return null;
  const release = body as Record<string, unknown>;

  const tag = typeof release.tag_name === "string" ? release.tag_name : null;
  if (!tag || !parseVersion(tag)) return null;

  return {
    version: tag.replace(/^v/, ""),
    apk: pickApk(release.assets),
    page:
      typeof release.html_url === "string"
        ? release.html_url
        : "https://github.com/lokeshmohanty/ecr/releases/latest",
  };
}

/**
 * Asks GitHub for the newest release and compares it with what is installed.
 *
 * Every failure is reported rather than thrown: the check is a convenience, and
 * a phone on a captive-portal wifi must be told that the check did not happen,
 * not left looking at a button that did nothing.
 */
export async function checkForUpdate(
  installed: string,
  fetcher: typeof fetch = fetch,
): Promise<UpdateState> {
  let body: unknown;
  try {
    const response = await fetcher(RELEASES_URL, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      return { kind: "failed", reason: `GitHub answered ${response.status}` };
    }
    body = await response.json();
  } catch {
    return { kind: "failed", reason: "could not reach GitHub" };
  }

  const release = readRelease(body);
  if (!release) return { kind: "failed", reason: "GitHub answered something unreadable" };

  const newer = isNewer(release.version, installed);
  if (newer === null) {
    return { kind: "failed", reason: `cannot compare ${installed} with ${release.version}` };
  }

  return newer ? { kind: "available", release } : { kind: "current", version: release.version };
}
