/**
 * Drives the real client against the real maildir. Makes no assumptions about
 * message content — only that mail exists and the UI can navigate it.
 * Usage: node verify-live.mjs <url> [token]
 */
import { chromium } from "playwright";

const [url, token = ""] = process.argv.slice(2);
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on("console", (m) => {
  if (m.type() === "error") notes.push(m.text().slice(0, 160));
});
page.on("pageerror", (e) => notes.push(`pageerror: ${e.message.slice(0, 160)}`));

await page.addInitScript(
  ([base, tok]) => {
    try {
      localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl: base, token: tok }));
    } catch {
      /* sandboxed frame */
    }
  },
  [url, token],
);

console.log("\nLoading");
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
check("no page errors", notes.length === 0, notes.slice(0, 2).join(" | "));

const rowSelector = "[class*='row-grid'][class*='cursor-pointer']";

console.log("\nInbox");
await page.waitForSelector(rowSelector, { timeout: 15000 }).catch(() => {});
const rows = await page.locator(rowSelector).count();
check("real mail renders", rows > 0, `${rows} rows windowed`);

const header = await page.textContent("body");
const counts = header.match(/(\d+)\/(\d+)/);
check("inbox count is real", counts && Number(counts[2]) > 1000, counts ? counts[0] : "not found");

console.log("\nLayout with real subjects and senders");
const overlap = await page.evaluate((sel) => {
  const problems = [];
  for (const row of document.querySelectorAll(sel)) {
    const cells = [...row.children];
    for (let i = 0; i < cells.length - 1; i++) {
      const a = cells[i].getBoundingClientRect();
      const b = cells[i + 1].getBoundingClientRect();
      if (a.width > 0 && b.width > 0 && a.right > b.left + 1) problems.push(Math.round(a.right - b.left));
    }
  }
  return problems;
}, rowSelector);
check("no overlapping cells", overlap.length === 0, overlap.slice(0, 3).join(","));

const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
check("no horizontal overflow", overflow <= 0, `${overflow}px`);

console.log("\nScrolling a 23k list");
const scroller = page.locator(".scroll-y").first();
await scroller.evaluate((el) => (el.scrollTop = 4000));
await page.waitForTimeout(600);
const afterScroll = await page.locator(rowSelector).count();
check("windowing keeps the row count bounded", afterScroll > 0 && afterScroll < 80, `${afterScroll} rows`);
await scroller.evaluate((el) => (el.scrollTop = 0));
await page.waitForTimeout(400);

console.log("\nOpening a real message");
await page.locator(rowSelector).first().click();
await page.waitForTimeout(2500);

const frame = page.frameLocator("iframe[title='message body']").first();
const bodyHtml = await frame
  .locator("body")
  .innerHTML({ timeout: 8000 })
  .catch(() => "");
check("a real body renders", bodyHtml.length > 0, `${bodyHtml.length} chars`);
check("no script survived", !bodyHtml.includes("<script"));

const broken = await frame
  .locator("img")
  .evaluateAll((imgs) => imgs.filter((i) => i.complete && i.naturalWidth === 0).length)
  .catch(() => 0);
check("no broken images in the body", broken === 0, `${broken} broken`);

console.log("\nSearch");
await page.keyboard.press("Escape");
await page.keyboard.press("/");
await page.waitForTimeout(400);
await page.keyboard.type("tag:sent");
await page.keyboard.press("Enter");
await page.waitForTimeout(3000);

// The query must be exactly what was typed. The palette is pre-filled with the
// current query, so this is also the regression test for `tag:inboxtag:sent` —
// typing must replace the prefill, not append to it.
const activeQuery = await page.inputValue("header input");
check("search replaces the query rather than appending", activeQuery === "tag:sent", activeQuery);

const sentCount = (await page.textContent("body")).match(/(\d+)\/(\d+)/);
check(
  "search returns real results",
  sentCount && Number(sentCount[2]) > 0,
  sentCount ? sentCount[0] : "none",
);

await page.keyboard.press("/");
await page.waitForTimeout(300);
const palettePrefill = await page.inputValue("input[data-palette]").catch(() => "x");
check(
  "the palette opens on the current query",
  palettePrefill === "tag:sent",
  JSON.stringify(palettePrefill),
);
const prefillSelected = await page.evaluate(() => {
  const el = document.activeElement;
  return el && el.selectionStart === 0 && el.selectionEnd === el.value.length;
});
check("with it selected, so a keystroke replaces it", prefillSelected);
await page.keyboard.press("Escape");

await page.keyboard.press("/");
await page.waitForTimeout(300);
await page.keyboard.type("tag:inbox");
await page.keyboard.press("Enter");
await page.waitForTimeout(2500);

console.log("\nAccounts");
await page.keyboard.press("Escape");
const accountNames = ["main", "work", "personal", "team"];
const sidebar = await page.textContent("nav").catch(() => "");
const found = accountNames.filter((a) => sidebar.includes(a));
check("every account is listed", found.length === accountNames.length, found.join(", "));

await page.screenshot({ path: "screenshots/live-desktop.png" });

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(700);
const mobileOverflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
check("no horizontal overflow on mobile", mobileOverflow <= 0, `${mobileOverflow}px`);
await page.screenshot({ path: "screenshots/live-mobile.png" });

await browser.close();

console.log(
  `\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} FAILED: ${failures.join(", ")}`}`,
);
if (notes.length) console.log(`notes:\n  ${notes.slice(0, 5).join("\n  ")}`);
process.exit(failures.length === 0 ? 0 : 1);
