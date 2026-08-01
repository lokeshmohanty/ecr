/**
 * Visual regression suite.
 *
 * Runs against the *fixture* maildir, never real mail: a baseline is only
 * meaningful if the content is fixed. Each state is captured, compared to its
 * baseline pixel by pixel, and any drift is written out as a diff image.
 *
 *   node visual.mjs <url>            compare against the baselines
 *   node visual.mjs <url> --approve  accept what is rendered as the new baseline
 */
import { chromium } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [url, ...flags] = process.argv.slice(2);
const approve = flags.includes("--approve");
const only = flags.find((f) => f.startsWith("--only="))?.slice(7);

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const BASELINE = join(ROOT, "screenshots/visual/baseline");
const CURRENT = join(ROOT, "screenshots/visual/current");
const DIFF = join(ROOT, "screenshots/visual/diff");

for (const dir of [BASELINE, CURRENT, DIFF]) mkdirSync(dir, { recursive: true });

/** How much drift is tolerated before a state is considered changed. */
const THRESHOLD = 0.1;
const MAX_DIFFERING_RATIO = 0.002;

const ROW = "[class*='row-grid'][class*='cursor-pointer']";

const press = async (page, ...keys) => {
  for (const key of keys) {
    await page.keyboard.press(key);
    await page.waitForTimeout(120);
  }
};

const chord = async (page, key) => {
  await page.keyboard.down("Control");
  await page.keyboard.press(key);
  await page.keyboard.up("Control");
  await page.waitForTimeout(200);
};

/**
 * Every state the UI can be in that a reader would notice. Each one starts
 * from a freshly loaded page so an earlier state cannot leak into a later one.
 */
const STATES = [
  {
    name: "01-thread-list",
    description: "the list on first load, all accounts",
    async setup() {},
  },
  {
    name: "02-thread-open",
    description: "a thread open in the detail pane",
    async setup(page) {
      await press(page, "Enter");
      await page.waitForTimeout(1800);
    },
  },
  {
    name: "03-sidebar-focused",
    description: "sidebar focused with its cursor visible",
    async setup(page) {
      await press(page, "h", "j");
    },
  },
  {
    name: "04-account-expanded",
    description: "an account group expanded to its views",
    async setup(page) {
      await page.evaluate(() => {
        [...document.querySelectorAll("nav button")]
          .find((b) => b.textContent.toLowerCase().includes("main"))
          ?.click();
      });
      await page.waitForTimeout(1200);
    },
  },
  {
    name: "05-search-palette",
    description: "the query prompt with live suggestions",
    async setup(page) {
      await press(page, "/");
      await page.keyboard.type("tag:un");
      await page.waitForTimeout(500);
    },
  },
  {
    name: "06-command-palette",
    description: "the command prompt",
    async setup(page) {
      await press(page, ":");
      await page.keyboard.type("sync");
      await page.waitForTimeout(300);
    },
  },
  {
    name: "07-help",
    description: "the keybinding overlay for the focused pane",
    async setup(page) {
      await press(page, "?");
      await page.waitForTimeout(400);
    },
  },
  {
    name: "08-marks-queued",
    description: "rows marked but not yet executed",
    async setup(page) {
      await press(page, "a", "j", "d", "j", "f");
      await page.waitForTimeout(400);
    },
  },
  {
    name: "09-compose-pinned",
    description: "a reply pinned below the thread it answers",
    async setup(page) {
      await press(page, "Enter");
      await page.waitForTimeout(1600);
      await press(page, "r");
      await page.waitForTimeout(1200);
    },
  },
  {
    name: "10-compose-minimised",
    description: "the pinned draft collapsed to its bar",
    async setup(page) {
      await press(page, "Enter");
      await page.waitForTimeout(1600);
      await press(page, "r");
      await page.waitForTimeout(1000);
      await chord(page, "b");
      await page.waitForTimeout(400);
    },
  },
  {
    name: "11-compose-blank",
    description: "a new message",
    async setup(page) {
      await press(page, "c");
      await page.waitForTimeout(1000);
    },
  },
  {
    name: "12-settings-packages",
    description: "package management",
    async setup(page) {
      await press(page, ",");
      await page.waitForTimeout(900);
    },
  },
  {
    name: "13-settings-text",
    description: "preferences and keybindings in the editor",
    async setup(page) {
      await press(page, ",");
      await page.waitForTimeout(700);
      await page.evaluate(() => {
        [...document.querySelectorAll("button")]
          .find((b) => b.textContent.includes("Preferences"))
          ?.click();
      });
      await page.waitForTimeout(800);
    },
  },
  {
    name: "14-empty-result",
    description: "a query that matches nothing",
    async setup(page) {
      await press(page, "/");
      await page.keyboard.type("tag:nonesuch-xyzzy");
      await press(page, "Enter");
      await page.waitForTimeout(1400);
    },
  },
  {
    name: "15-plain-text",
    description: "a message forced to plain text",
    async setup(page) {
      await press(page, "Enter");
      await page.waitForTimeout(1800);
      await press(page, "l", "t");
      await page.waitForTimeout(1400);
    },
  },
  {
    name: "16-mobile-list",
    description: "the list at phone width",
    viewport: { width: 390, height: 844 },
    async setup() {},
  },
  {
    name: "17-mobile-detail",
    description: "a thread at phone width",
    viewport: { width: 390, height: 844 },
    async setup(page) {
      await press(page, "Enter");
      await page.waitForTimeout(1800);
    },
  },
  {
    name: "18-narrow-desktop",
    description: "the three panes squeezed to 900px",
    viewport: { width: 900, height: 760 },
    async setup(page) {
      await press(page, "Enter");
      await page.waitForTimeout(1800);
    },
  },
];

const browser = await chromium.launch({
  executablePath: "/run/current-system/sw/bin/google-chrome-stable",
  args: ["--no-sandbox", "--force-device-scale-factor=1", "--hide-scrollbars"],
});

const failures = [];
const created = [];
const passed = [];

for (const state of STATES) {
  if (only && !state.name.includes(only)) continue;

  const context = await browser.newContext({
    viewport: state.viewport ?? { width: 1440, height: 900 },
    colorScheme: "dark",
    deviceScaleFactor: 1,
    // Freeze anything that would otherwise drift between runs.
    timezoneId: "Asia/Kolkata",
    locale: "en-GB",
    reducedMotion: "reduce",
  });

  const page = await context.newPage();
  await page.addInitScript((base) => {
    try {
      localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl: base, token: "" }));
      localStorage.removeItem("ecr.settings");
    } catch {
      /* sandboxed frame */
    }
  }, url);

  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector(ROW, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(900);

  await state.setup(page);
  await page.waitForTimeout(500);

  // Caret blink and any in-flight transition would otherwise flap the diff.
  await page.addStyleTag({
    content: `*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }`,
  });
  await page.waitForTimeout(200);

  const file = `${state.name}.png`;
  const shot = await page.screenshot({ path: join(CURRENT, file) });
  await context.close();

  const baselinePath = join(BASELINE, file);

  if (!existsSync(baselinePath) || approve) {
    writeFileSync(baselinePath, shot);
    created.push(state.name);
    console.log(`  new  ${state.name} — ${state.description}`);
    continue;
  }

  const before = PNG.sync.read(readFileSync(baselinePath));
  const after = PNG.sync.read(shot);

  if (before.width !== after.width || before.height !== after.height) {
    failures.push(`${state.name}: size changed ${before.width}x${before.height} → ${after.width}x${after.height}`);
    console.log(`  FAIL ${state.name} — size changed`);
    continue;
  }

  const diff = new PNG({ width: before.width, height: before.height });
  const differing = pixelmatch(before.data, after.data, diff.data, before.width, before.height, {
    threshold: THRESHOLD,
  });
  const ratio = differing / (before.width * before.height);

  if (ratio > MAX_DIFFERING_RATIO) {
    writeFileSync(join(DIFF, file), PNG.sync.write(diff));
    failures.push(`${state.name}: ${(ratio * 100).toFixed(2)}% of pixels changed`);
    console.log(`  FAIL ${state.name} — ${(ratio * 100).toFixed(2)}% changed, diff written`);
  } else {
    passed.push(state.name);
    console.log(`  ok   ${state.name} — ${state.description}`);
  }
}

await browser.close();

console.log();
if (created.length) console.log(`${created.length} baseline${created.length === 1 ? "" : "s"} written`);
if (passed.length) console.log(`${passed.length} unchanged`);
if (failures.length) {
  console.log(`\n${failures.length} CHANGED:`);
  for (const failure of failures) console.log(`  ${failure}`);
  console.log(`\nReview screenshots/visual/diff, then re-run with --approve if the change is wanted.`);
}
process.exit(failures.length === 0 ? 0 : 1);
