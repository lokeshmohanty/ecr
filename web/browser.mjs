import { existsSync } from "node:fs";

// On NixOS Playwright's bundled chromium dies on a missing libnspr4.so, so the
// system Chrome is used instead. Everywhere else — CI included — the bundled
// build is the right one, and `undefined` selects it. ECR_CHROME overrides both.
//
// **The visual suite must not use this fallback.** Two different browser builds
// rasterise the same glyph differently, so baselines recorded under Chrome and
// compared under Chromium drift about 1% on every state at once — every state
// failing by roughly the same amount is the signature, and it says nothing
// about the UI. `just visual` pins ECR_CHROME to the chromium the flake pins,
// which is the same build here and in CI. See scripts/visual.sh.
const NIXOS_CHROME = "/run/current-system/sw/bin/google-chrome-stable";

export const executablePath =
  process.env.ECR_CHROME || (existsSync(NIXOS_CHROME) ? NIXOS_CHROME : undefined);

/**
 * Refuses every request that does not go to the fixture server.
 *
 * The fixture mail carries a remote image — `tracker.example.com`, in
 * `multipart_related.eml` — and remote images are loaded by default now, so a
 * suite that opens that message really does try to fetch it. What comes back
 * is whatever the machine's resolver and the network between it and the run
 * feel like today: a cert error here, a timeout in CI, nothing at all offline.
 * None of it is about the client, all of it costs time, and for `just visual`
 * it is the difference between a deterministic baseline and one that depends
 * on DNS.
 *
 * Refused rather than stubbed, because a refusal arrives at once and is what
 * a reader of a fixture mailbox should be shown.
 *
 * Registered before any state adds a route of its own: Playwright matches the
 * most recently registered handler first, so a suite that fulfils
 * `**​/api/v1/**` still wins over this.
 */
export async function keepOffline(page, serverUrl) {
  const origin = new URL(serverUrl).origin;

  await page.route("**/*", (route) => {
    let target;
    try {
      target = new URL(route.request().url());
    } catch {
      return route.continue();
    }

    const local =
      target.origin === origin ||
      target.hostname === "localhost" ||
      target.hostname === "127.0.0.1" ||
      target.protocol === "data:" ||
      target.protocol === "blob:";

    return local ? route.continue() : route.abort();
  });
}
