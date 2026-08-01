import { defineConfig } from "@playwright/test";

/**
 * Playwright's bundled Chromium fails on NixOS looking for libnspr4.so, so every
 * browser here is the system Chrome — the same choice the older verify-*.mjs
 * scripts make.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "list" : [["list"]],
  use: {
    launchOptions: {
      executablePath:
        process.env.ECR_CHROME ?? "/run/current-system/sw/bin/google-chrome-stable",
      args: ["--no-sandbox"],
    },
    // Matched to visual.mjs so a date rendered here means what it means there.
    timezoneId: "Asia/Kolkata",
    locale: "en-GB",
    reducedMotion: "reduce",
    colorScheme: "dark",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
});
