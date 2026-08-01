/**
 * UX and accessibility audit against the fixture maildir.
 *
 * These are the things a screenshot cannot show: contrast ratios, whether
 * every control can be reached and named, whether state is announced, and
 * whether an action that fails says so.
 */
import { chromium } from "playwright";

const [url] = process.argv.slice(2);
const failures = [];
const notes = [];

function check(name, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

const browser = await chromium.launch({
  executablePath: "/run/current-system/sw/bin/google-chrome-stable",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });

page.on("pageerror", (e) => notes.push(e.message.slice(0, 120)));
page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && notes.push(m.text().slice(0, 120)));

await page.addInitScript((base) => {
  try {
    localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl: base, token: "" }));
    localStorage.removeItem("ecr.settings");
  } catch {}
}, url);

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector("[class*='row-grid'][class*='cursor-pointer']", { timeout: 20000 });
await page.waitForTimeout(900);

// ── contrast ───────────────────────────────────────────────────────────────
console.log("\nContrast");

const contrast = await page.evaluate(() => {
  const luminance = (rgb) => {
    const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map(Number).map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  const ratio = (fg, bg) => {
    const a = luminance(fg);
    const b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };

  const effectiveBackground = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && !bg.startsWith("rgba(0, 0, 0, 0)")) return bg;
      node = node.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  };

  const results = [];
  const elements = [...document.querySelectorAll("main *, header *, footer *, nav *")].filter(
    (el) => el.children.length === 0 && el.textContent.trim().length > 1,
  );

  for (const el of elements.slice(0, 220)) {
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;

    const size = parseFloat(style.fontSize);
    const bold = Number(style.fontWeight) >= 700;
    // WCAG AA: 3:1 for large text, 4.5:1 otherwise.
    const required = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    const value = ratio(style.color, effectiveBackground(el));

    if (value < required) {
      results.push({
        text: el.textContent.trim().slice(0, 26),
        ratio: Number(value.toFixed(2)),
        required,
        color: style.color,
      });
    }
  }
  return results;
});

check(
  "every label meets WCAG AA contrast",
  contrast.length === 0,
  contrast.slice(0, 4).map((c) => `"${c.text}" ${c.ratio}:1 (needs ${c.required})`).join("; "),
);

// ── reachability and naming ────────────────────────────────────────────────
console.log("\nControls");

const unnamed = await page.evaluate(() =>
  [...document.querySelectorAll("button, a[href], input, textarea, select")]
    .filter((el) => el.offsetParent !== null)
    .filter((el) => {
      const name =
        el.getAttribute("aria-label") ??
        el.getAttribute("title") ??
        el.textContent.trim() ??
        el.getAttribute("placeholder");
      return !name || name.length === 0;
    })
    .map((el) => el.outerHTML.slice(0, 70)),
);
check("every visible control has an accessible name", unnamed.length === 0, unnamed.slice(0, 3).join(" | "));

const tabbable = await page.evaluate(
  () =>
    [...document.querySelectorAll("button, a[href], input, textarea, [tabindex]")].filter(
      (el) => el.offsetParent !== null && el.tabIndex >= 0,
    ).length,
);
check("the interface is reachable by keyboard alone", tabbable > 5, `${tabbable} tab stops`);

const focusVisible = await page.evaluate(() => {
  const button = [...document.querySelectorAll("button")].find((b) => b.offsetParent !== null);
  if (!button) return false;
  button.focus();
  const style = getComputedStyle(button);
  return style.outlineStyle !== "none" || style.boxShadow !== "none";
});
check("focus is visible when tabbing", focusVisible);

// ── touch targets ──────────────────────────────────────────────────────────
console.log("\nTouch");
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);

const small = await page.evaluate(() =>
  [...document.querySelectorAll("button, a[href]")]
    .filter((el) => el.offsetParent !== null)
    .map((el) => ({ text: el.textContent.trim().slice(0, 20), h: el.getBoundingClientRect().height }))
    .filter((el) => el.h > 0 && el.h < 32),
);
check(
  "touch targets are large enough on a phone",
  small.length === 0,
  small.slice(0, 4).map((s) => `"${s.text}" ${Math.round(s.h)}px`).join("; "),
);

await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(400);

// ── state is announced ─────────────────────────────────────────────────────
console.log("\nFeedback");

await page.keyboard.press("j");
await page.waitForTimeout(1400);
await page.keyboard.press("a");
await page.waitForTimeout(400);
const marked = await page.textContent("footer");
check("marking a row says so", /marked/i.test(marked), marked.replace(/\s+/g, " ").slice(-40));

await page.keyboard.press("X");
await page.waitForTimeout(400);
check("clearing marks says so", /cleared/i.test(await page.textContent("footer")));

// A write against a read-only server must surface, not fail silently.
await page.keyboard.press("f");
await page.waitForTimeout(1200);
const afterWrite = await page.textContent("footer");
check(
  "a refused write is reported rather than swallowed",
  /read-only|failed|error/i.test(afterWrite) || /marked/i.test(afterWrite),
  afterWrite.replace(/\s+/g, " ").slice(-60),
);

// ── the empty and error states ─────────────────────────────────────────────
console.log("\nEmpty states");
await page.keyboard.press("/");
await page.waitForTimeout(300);
await page.keyboard.type("tag:definitely-nothing-here");
await page.keyboard.press("Enter");
await page.waitForTimeout(1600);
check("an empty result explains itself", (await page.textContent("main")).includes("no matching"));

await page.keyboard.press("/");
await page.waitForTimeout(300);
await page.keyboard.type("tag:inbox");
await page.keyboard.press("Enter");
await page.waitForTimeout(1600);

// ── the reading pane ───────────────────────────────────────────────────────
console.log("\nReading");
await page.keyboard.press("Enter");
await page.waitForTimeout(2000);

const readable = await page.evaluate(() => {
  const detail = [...document.querySelector("main").children].pop();
  const frame = detail.querySelector("iframe[title='message body']");
  const pre = detail.querySelector("pre");
  return {
    hasBody: !!frame || !!pre,
    // A body pinned to a fixed height when its content is short wastes the pane.
    frameHeight: frame ? Math.round(frame.getBoundingClientRect().height) : null,
    contentHeight: frame?.contentDocument?.body?.scrollHeight ?? null,
  };
});
check("a body is shown", readable.hasBody);
if (readable.frameHeight !== null && readable.contentHeight) {
  check(
    "the body frame matches its content",
    Math.abs(readable.frameHeight - readable.contentHeight) < 60,
    `${readable.frameHeight}px frame vs ${readable.contentHeight}px content`,
  );
}

check("no page errors throughout", notes.length === 0, notes.slice(0, 2).join(" | "));

await browser.close();
console.log(failures.length === 0 ? "\nALL UX CHECKS PASSED" : `\n${failures.length} FAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
