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
import { executablePath, keepOffline } from "./browser.mjs";
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

/**
 * How still the page must be before it is photographed, and how long it is
 * given to get there.
 *
 * Nothing in this suite waits out a duration any more, and that is the point.
 * Every state used to sleep for a number between 120 and 1800ms, chosen by
 * hand against an idle machine, and then take the screenshot whether or not the
 * client had arrived: under CPU contention five states — `08-marks-queued`,
 * `21-list-range-selected`, `22-tag-prompt`, `29-mobile-selection` and
 * `31-auth-refused` — reported diffs that were nothing but a client caught
 * mid-render. That is the worst failure this suite can have. A real regression
 * and a busy machine are indistinguishable in the output, so the verdict stops
 * meaning anything, and two baselines were approved from unsettled renders
 * before the cause was understood.
 *
 * No single number can be right for both a laptop under load and CI, so the
 * wait is for the condition the number was standing in for: no request
 * outstanding, no indicator up, and the DOM unchanged for `QUIET`. A slow
 * machine takes longer rather than lying, and a state that genuinely never
 * settles fails as itself instead of as a pixel diff.
 */
const QUIET = 250;
const SETTLE_TIMEOUT = 20_000;

/**
 * Installed in every page before its own scripts run: the record of when the
 * page last did anything.
 *
 * `fetch` is wrapped rather than watched from node because what matters is
 * whether the *client* is still waiting, which Playwright's own idle notions
 * answer badly here — the client holds an `EventSource` open for the life of
 * the page, so a network-idle wait is either never satisfied or satisfied for
 * the wrong reason. `EventSource` is not `fetch`, so it is invisible to this
 * and stays that way deliberately.
 */
const WATCH_ACTIVITY = () => {
  const activity = { last: performance.now(), inflight: 0 };
  window.__ecrSettle = activity;

  const bump = () => {
    activity.last = performance.now();
  };

  new MutationObserver(bump).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });

  const inner = window.fetch;
  window.fetch = (...args) => {
    activity.inflight += 1;
    bump();
    let pending;
    try {
      pending = inner(...args);
    } catch (error) {
      activity.inflight -= 1;
      throw error;
    }
    return pending.finally(() => {
      activity.inflight -= 1;
      bump();
    });
  };
};

/**
 * Resolves once the page has stopped changing.
 *
 * The loading indicator is named explicitly rather than left to `QUIET`,
 * because `createDelayed` keeps it up for a floor of 300ms *after* the request
 * it describes has landed — so the last mutation is the word being removed, and
 * a quiet period shorter than that floor races it. That is the same coin flip
 * this whole helper exists to remove, one layer down.
 */
const settle = async (page, { quiet = QUIET, timeout = SETTLE_TIMEOUT } = {}) => {
  await page.waitForFunction(
    (ms) => {
      const activity = window.__ecrSettle;
      if (!activity || activity.inflight > 0) return false;
      if (document.fonts.status !== "loaded") return false;
      if (document.body?.textContent?.includes("loading…")) return false;
      return performance.now() - activity.last >= ms;
    },
    quiet,
    { timeout, polling: "raf" },
  );
};

/** One painted frame — what a keystroke needs, rather than a tenth of a second. */
const frame = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

const press = async (page, ...keys) => {
  for (const key of keys) {
    await page.keyboard.press(key);
    await frame(page);
  }
};

const chord = async (page, key) => {
  await page.keyboard.down("Control");
  await page.keyboard.press(key);
  await page.keyboard.up("Control");
  await frame(page);
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
    name: "04-account-switcher",
    description: "the switcher the account box opens",
    async setup(page) {
      // What replaced expanding an account group in the sidebar: the box names
      // the account whose mailboxes are below it, and opens this to change it.
      await page.click("[data-account-box]");
      await page.waitForSelector("[role='dialog']");
    },
  },
  {
    name: "05-search-palette",
    description: "the query prompt with live suggestions",
    async setup(page) {
      await press(page, "/");
      await page.keyboard.type("tag:un");
    },
  },
  {
    name: "06-command-palette",
    description: "the command prompt",
    async setup(page) {
      await press(page, ":");
      await page.keyboard.type("sync");
    },
  },
  {
    name: "07-help",
    description: "the keybinding overlay for the focused pane",
    async setup(page) {
      await press(page, "?");
    },
  },
  {
    name: "08-marks-queued",
    description: "rows marked but not yet executed",
    async setup(page) {
      await press(page, "a", "j", "d", "j", "f");
    },
  },
  {
    name: "09-compose-pinned",
    description: "a reply pinned below the thread it answers",
    async setup(page) {
      await press(page, "Enter");
      // Reply reads the thread that is open, so this is not impatience being
      // smoothed over: pressing `r` before the messages are in hand answers the
      // wrong thing, or nothing.
      await settle(page);
      await press(page, "r");
    },
  },
  {
    name: "10-compose-minimised",
    description: "the pinned draft collapsed to its bar",
    async setup(page) {
      await press(page, "Enter");
      await settle(page);
      await press(page, "r");
      await settle(page);
      await chord(page, "b");
    },
  },
  {
    name: "11-compose-blank",
    description: "a new message",
    async setup(page) {
      await press(page, "c");
    },
  },
  {
    name: "12-settings-packages",
    description: "package management",
    async setup(page) {
      await press(page, ",");
      // Settings open on the device tab, so a state that does not pick its own
      // tab photographs the wrong one — which is how both of these spent a
      // release claiming to cover a page they never showed.
      await page.getByRole("button", { name: "Packages" }).click();
    },
  },
  {
    name: "12b-settings-device",
    description: "the settings this device keeps to itself",
    async setup(page) {
      await press(page, ",");
    },
  },
  {
    name: "13-settings-text",
    description: "the shared file in the editor",
    async setup(page) {
      await press(page, ",");
      await page.getByRole("button", { name: "Shared file" }).click();
    },
  },
  {
    name: "14-empty-result",
    description: "a query that matches nothing",
    async setup(page) {
      await press(page, "/");
      await page.keyboard.type("tag:nonesuch-xyzzy");
      await press(page, "Enter");
    },
  },
  {
    name: "15-plain-text",
    description: "a message forced to plain text",
    async setup(page) {
      await press(page, "Enter");
      await settle(page);
      await press(page, "l", "t");
    },
  },
  {
    // The other plain-text state opens a message that carries no markup, so it
    // shows the `text/plain` part and says nothing about the conversion. This
    // one is the `multipart/alternative` fixture: what is on screen is its HTML
    // read as Markdown, and the plain half beside it — "Plain text fallback
    // with a ☁ cloud" — is what would be there if the fallback had won.
    name: "15b-plain-text-markdown",
    description: "a message with markup, read as text",
    async setup(page) {
      await press(page, "/");
      await page.keyboard.type("id:mime1@example.com");
      await press(page, "Enter");
      await settle(page);
      await press(page, "Enter");
      await settle(page);
      await press(page, "l", "t");
    },
  },
  {
    name: "16-mobile-list",
    description: "the list at phone width",
    viewport: PHONE,
    async setup() {},
  },
  {
    name: "17-mobile-detail",
    description: "a thread at phone width",
    viewport: PHONE,
    async setup(page) {
      await press(page, "Enter");
    },
  },
  {
    name: "18-narrow-desktop",
    description: "two panes at 900px, the sidebar folded into a drawer",
    viewport: { width: 900, height: 760 },
    async setup(page) {
      await press(page, "Enter");
    },
  },
  {
    name: "19-view-cursor",
    description: "a block cursor reading inside the message",
    async setup(page) {
      await press(page, "Enter");
      // View mode flattens whichever document is on screen, so it has to be on
      // screen: entering it against a pane still waiting for its body attaches
      // the cursor to nothing.
      await settle(page);
      await press(page, "l");
      await press(page, "Enter");
      await press(page, "w");
      await press(page, "w");
    },
  },
  {
    name: "20-view-selection",
    description: "a visual selection inside the message",
    async setup(page) {
      await press(page, "Enter");
      await settle(page);
      await press(page, "l");
      await press(page, "Enter");
      await press(page, "v");
      for (const _ of [0, 1, 2, 3, 4, 5]) await press(page, "l");
    },
  },
  {
    name: "21-list-range-selected",
    description: "a v range over the list, with a delete staged on it",
    async setup(page) {
      await press(page, "v");
      await press(page, "j");
      await press(page, "j");
      await press(page, "d");
    },
  },
  {
    name: "22-tag-prompt",
    description: "the prompt that stages any tag on the selection",
    async setup(page) {
      await press(page, "Space");
      await press(page, "j");
      await press(page, "Space");
      await press(page, "t");
      await page.keyboard.type("+ho");
    },
  },
  {
    name: "23-compose-attachment",
    description: "a draft carrying a file",
    async setup(page) {
      await press(page, "c");
      await settle(page);
      await page.setInputFiles('input[type="file"]', {
        name: "agenda.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4 minutes of the meeting"),
      });
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
    },
  },
  {
    name: "25-mobile-insets",
    description: "the chrome held clear of the status and gesture bars",
    viewport: PHONE,
    insets: { top: 48, bottom: 24 },
    async setup(page) {
      await press(page, "Enter");
    },
  },
  {
    name: "26-mobile-compose",
    description: "writing a message on a phone",
    viewport: PHONE,
    insets: { top: 48, bottom: 24 },
    async setup(page) {
      await press(page, "c");
    },
  },
  {
    name: "27-mobile-settings",
    description: "the package cards at phone width",
    viewport: PHONE,
    insets: { top: 48, bottom: 24 },
    async setup(page) {
      await press(page, ",");
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
      const rows = page.locator(ROW);
      await rows.nth(0).click();
      await rows.nth(2).click();
    },
  },
  {
    name: "30-mobile-detail-actions",
    description: "a thread, with reply and the rest under the thumb",
    viewport: PHONE,
    insets: { top: 48, bottom: 24 },
    async setup(page) {
      await page.locator(ROW).first().click();
    },
  },
  {
    // The fixture server has no token store, so nothing it serves can be
    // refused: the refusal is faked at the wire instead. What is being
    // captured is the client's side of it either way — the prompt, over the
    // list saying why it is empty.
    name: "31-auth-refused",
    description: "a device the server will not talk to, asking for a token",
    async setup(page) {
      // Every route but the public one. `/api/v1/health` answers a refused
      // device exactly as it answers a paired one, and that is the whole
      // difference between this state and an unreachable server: guarding it
      // here would model a server that is not running, and the client would
      // rightly ask for an address rather than for a token.
      await page.route("**/api/v1/**", (route) =>
        route.request().url().includes("/api/v1/health")
          ? route.continue()
          : route.fulfill({
              status: 401,
              contentType: "application/json",
              body: JSON.stringify({
                error: "unauthorized",
                detail: "a valid bearer token is required",
              }),
            }),
      );
      await page.reload({ waitUntil: "domcontentloaded" });
    },
  },
  {
    // The other half of 18: what the sidebar looks like once it is asked for.
    // The thread behind it is what the drawer is for — it does not move, so
    // changing mailbox never costs the message being read.
    name: "32-sidebar-drawer",
    description: "the sidebar over the list at 900px, the thread still in place",
    viewport: { width: 900, height: 760 },
    async setup(page) {
      await press(page, "Enter");
      // The thread has to be there for the drawer to be over it, which is the
      // whole of what this state says.
      await settle(page);
      await press(page, "h", "h");
    },
  },
];

// Text rendering is the whole of this suite's noise. Hinting and subpixel
// positioning are decided by the platform's FreeType and fontconfig, so the
// same glyph lands on different pixels on two machines that agree on
// everything else — which is how these baselines drifted 0.4% across every
// state at once, after pinning the browser had already removed the first 1%.
// Turning all three off costs nothing here: nobody reads these images, they
// are only ever compared.
const browser = await chromium.launch({
  executablePath,
  args: [
    "--no-sandbox",
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "--font-render-hinting=none",
    "--disable-font-subpixel-positioning",
    "--disable-lcd-text",
  ],
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

  // Before every other route, and before the client can ask for anything: a
  // baseline that depends on whether a remote image resolved today is not a
  // baseline. See `keepOffline`.
  await keepOffline(page, url);

  await page.addInitScript(WATCH_ACTIVITY);
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

  // `domcontentloaded`, not `networkidle`: the client opens an `EventSource` and
  // keeps it open, so network idle here is a wait on something that does not
  // happen. What the load has to reach is a settled client, which is asked for
  // directly below.
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ROW, { timeout: 20000 }).catch(() => {});

  // A state that cannot be reached is reported as itself. Photographing it
  // anyway is what produced diffs nobody could account for, and the failure is
  // the useful half: it names the state and says what it was still waiting for.
  try {
    await settle(page);
    await state.setup(page);
    await settle(page);
  } catch (error) {
    await context.close();
    const why = String(error).split("\n")[0];
    failures.push(`${state.name}: never settled — ${why}`);
    console.log(`  FAIL ${state.name} — never settled`);
    continue;
  }

  // Caret blink and any in-flight transition would otherwise flap the diff.
  await page.addStyleTag({
    content: `*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }`,
  });
  await frame(page);

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
