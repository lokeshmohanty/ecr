import { existsSync } from "node:fs";

// On NixOS Playwright's bundled chromium dies on a missing libnspr4.so, so the
// system Chrome is used instead. Everywhere else — CI included — the bundled
// build is the right one, and `undefined` selects it. ECR_CHROME overrides both.
const NIXOS_CHROME = "/run/current-system/sw/bin/google-chrome-stable";

export const executablePath =
  process.env.ECR_CHROME || (existsSync(NIXOS_CHROME) ? NIXOS_CHROME : undefined);
