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
