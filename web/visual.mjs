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
import { executablePath } from "./browser.mjs";
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

/** The device this was built against: 1240x2772 at 560dpi, so 3.5 CSS to one. */
const PHONE = { width: 354, height: 792 };

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
      // Settings open on the device tab, so a state that does not pick its own
      // tab photographs the wrong one — which is how both of these spent a
      // release claiming to cover a page they never showed.
      await page.getByRole("button", { name: "Packages" }).click();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "12b-settings-device",
    description: "the settings this device keeps to itself",
    async setup(page) {
      await press(page, ",");
      await page.waitForTimeout(900);
    },
  },
  {
    name: "13-settings-text",
    description: "the shared file in the editor",
    async setup(page) {
      await press(page, ",");
      await page.waitForTimeout(700);
      await page.getByRole("button", { name: "Shared file" }).click();
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
  {
    name: "19-view-cursor",
    description: "a block cursor reading inside the message",
    async setup(page) {
      await press(page, "Enter");
      await page.waitForTimeout(1800);
      await press(page, "l");
      await press(page, "Enter");
      await page.waitForTimeout(500);
      await press(page, "w");
      await press(page, "w");
      await page.waitForTimeout(300);
    },
  },
  {
    name: "20-view-selection",
    description: "a visual selection inside the message",
    async setup(page) {
      await press(page, "Enter");
      await page.waitForTimeout(1800);
      await press(page, "l");
      await press(page, "Enter");
      await page.waitForTimeout(500);
      await press(page, "v");
      for (const _ of [0, 1, 2, 3, 4, 5]) await press(page, "l");
      await page.waitForTimeout(300);
    },
  },
  {
    name: "21-list-range-selected",
    description: "a v range over the list, with a delete staged on it",
    async setup(page) {
      await page.waitForTimeout(600);
      await press(page, "v");
      await press(page, "j");
      await press(page, "j");
      await press(page, "d");
      await page.waitForTimeout(400);
    },
  },
  {
    name: "22-tag-prompt",
    description: "the prompt that stages any tag on the selection",
    async setup(page) {
      await page.waitForTimeout(600);
      await press(page, "Space");
      await press(page, "j");
      await press(page, "Space");
      await press(page, "t");
      await page.waitForTimeout(300);
      await page.keyboard.type("+ho");
      await page.waitForTimeout(400);
    },
  },
  {
    name: "23-compose-attachment",
    description: "a draft carrying a file",
    async setup(page) {
      await press(page, "c");
      await page.waitForTimeout(900);
      await page.setInputFiles('input[type="file"]', {
        name: "agenda.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4 minutes of the meeting"),
      });
      await page.waitForTimeout(500);
    },
  },

  /*
   * The phone. `PHONE` is the CSS viewport of the device this was built
   * against — 1240x2772 at 560dpi, so 3.5 device pixels to one CSS pixel — not
   * a round number chosen to look like a phone.
   */
  {
    name: "24-mobile-sidebar",
    description: "the sidebar as the phone's third pane",
    viewport: PHONE,
    async setup(page) {
      await page.getByRole("button", { name: "Views" }).click();
      await page.waitForTimeout(700);
    },
  },
  {
    name: "25-mobile-insets",
    description: "the chrome held clear of the status and gesture bars",
    viewport: PHONE,
    insets: { top: 48, bottom: 24 },
    async setup(page) {
      await press(page, "Enter");
      await page.waitForTimeout(1800);
    },
  },
  {
    name: "26-mobile-compose",
    description: "writing a message on a phone",
    viewport: PHONE,
    insets: { top: 48, bottom: 24 },
    async setup(page) {
      await press(page, "c");
      await page.waitForTimeout(900);
    },
  },
  {
    name: "27-mobile-settings",
    description: "the package cards at phone width",
    viewport: PHONE,
    insets: { top: 48, bottom: 24 },
    async setup(page) {
      await press(page, ",");
      await page.waitForTimeout(1200);
    },
  },
  {
    name: "28-mobile-actions",
    description: "the action bar that replaces the keys on a phone",
    viewport: PHONE,
    insets: { top: 48, bottom: 24 },
    async setup() {},
  },
  {
    name: "29-mobile-selection",
    description: "rows picked by hand, with the checkboxes a phone needs",
    viewport: PHONE,
    insets: { top: 48, bottom: 24 },
    async setup(page) {
      await page.getByRole("button", { name: "Select" }).click();
      await page.waitForTimeout(400);
      const rows = page.locator(ROW);
      await rows.nth(0).click();
      await rows.nth(2).click();
      await page.waitForTimeout(500);
    },
  },
  {
    name: "30-mobile-detail-actions",
    description: "a thread, with reply and the rest under the thumb",
    viewport: PHONE,
    insets: { top: 48, bottom: 24 },
    async setup(page) {
      await page.locator(ROW).first().click();
      await page.waitForTimeout(1800);
    },
  },
];

const browser = await chromium.launch({
  executablePath,
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

  // The fixtures are dated 2026-04-01 and the list now formats that date
  // relative to today: without a fixed clock these baselines would quietly
  // change shape at the next new year rather than when someone changed the UI.
  await context.clock.setFixedTime(new Date("2026-08-01T12:30:00Z"));

  const page = await context.newPage();
  await page.addInitScript((base) => {
    try {
      localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl: base, token: "" }));
      localStorage.removeItem("ecr.settings");
    } catch {
      /* sandboxed frame */
    }
  }, url);

  // A headless browser has no cutout and no way to be given one, so the state
  // asks for the insets it wants and they arrive the way the phone's would:
  // through the variables the chrome reads. `env()` supplies the real numbers.
  if (state.insets) {
    await page.addInitScript((insets) => {
      addEventListener("DOMContentLoaded", () => {
        const root = document.documentElement.style;
        root.setProperty("--safe-top", `${insets.top ?? 0}px`);
        root.setProperty("--safe-bottom", `${insets.bottom ?? 0}px`);
        root.setProperty("--safe-left", `${insets.left ?? 0}px`);
        root.setProperty("--safe-right", `${insets.right ?? 0}px`);
      });
    }, state.insets);
  }

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
