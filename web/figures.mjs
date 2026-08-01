/**
 * The figures the README shows.
 *
 * Distinct from visual.mjs: those are per-state baselines for regression, these
 * are a curated handful meant to be looked at. Both drive the fixture maildir,
 * and both pin the clock and timezone — a figure that changes when nobody
 * changed anything is a figure nobody trusts.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const url = process.argv[2];
if (!url) {
  console.error("usage: node web/figures.mjs <server-url>");
  process.exit(2);
}

const OUT = "figures";
mkdirSync(OUT, { recursive: true });

const CLOCK = new Date("2026-08-01T12:30:00Z");
const ROW = "[class*='row-grid'][class*='cursor-pointer']";

const browser = await chromium.launch({
  executablePath: "/run/current-system/sw/bin/google-chrome-stable",
  args: ["--no-sandbox", "--force-device-scale-factor=1", "--hide-scrollbars"],
});

async function shoot(name, { width = 1440, height = 900, theme, setup } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: "dark",
    deviceScaleFactor: 2, // Retina-sharp in the README.
    timezoneId: "Asia/Kolkata",
    locale: "en-GB",
    reducedMotion: "reduce",
  });
  await context.clock.setFixedTime(CLOCK);

  // Written before the page loads, so the client adopts it on its first read
  // rather than painting the default and flipping.
  await fetch(`${url}/api/v1/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      raw: theme ? `[appearance]\ntheme = "${theme}"\n` : "",
    }),
  });

  const page = await context.newPage();
  await page.addInitScript((base) => {
    try {
      localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl: base, token: "" }));
      localStorage.removeItem("ecr.settings");
      localStorage.removeItem("ecr.settings.toml");
      localStorage.removeItem("ecr.theme.toml");
    } catch {
      /* sandboxed frame */
    }
  }, url);

  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector(ROW, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);

  if (setup) await setup(page);
  await page.waitForTimeout(600);

  await page.addStyleTag({
    content: `*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }`,
  });

  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  await context.close();
  console.log(`  ${file}`);
}

const press = async (page, ...keys) => {
  for (const key of keys) {
    await page.keyboard.press(key);
    await page.waitForTimeout(120);
  }
};

console.log("figures:");

await shoot("web-desktop", {
  async setup(page) {
    await press(page, "j", "Enter");
  },
});

await shoot("web-mobile", { width: 390, height: 844 });

await shoot("sidebar", {
  width: 1100,
  height: 760,
  async setup(page) {
    await press(page, "h", "j");
  },
});

await shoot("reading", {
  async setup(page) {
    await press(page, "j", "j", "Enter");
  },
});

// One frame per palette, so the README can show what "themeable" means rather
// than assert it.
for (const preset of ["tokyonight", "gruvbox-dark", "nord", "everforest", "ecr-light"]) {
  await shoot(`theme-${preset}`, {
    width: 1100,
    height: 700,
    theme: `themes/${preset}.toml`,
    async setup(page) {
      await press(page, "j", "Enter");
    },
  });
}

await browser.close();
console.log("done");
