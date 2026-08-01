/**
 * Reading with a cursor. The risky part is that the parent paints a selection
 * inside a frame sandboxed without `allow-scripts`, which no unit test can
 * stand in for, so it is driven here in a real browser — over an HTML body and
 * over a plain-text one.
 */
import { chromium } from "playwright";
import { executablePath } from "./browser.mjs";

const [url] = process.argv.slice(2);
let failures = 0;

const ok = (name, detail = "") => console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
const fail = (name, detail) => {
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};
const check = (name, condition, detail) => (condition ? ok(name, detail) : fail(name, detail));

const browser = await chromium.launch({
  executablePath,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => fail("page error", e.message));

const press = async (...keys) => {
  for (const key of keys) {
    await page.keyboard.press(key);
    await page.waitForTimeout(110);
  }
};

/** What the cursor covers inside the message frame. */
const frameSelection = () =>
  page.evaluate(() => {
    const frame = document.querySelector('iframe[title="message body"]');
    return frame?.contentDocument?.getSelection()?.toString() ?? null;
  });

const paneSelection = () =>
  page.evaluate(() => document.getSelection()?.toString() ?? null);

const openSubject = async (subject) => {
  await page.evaluate((wanted) => {
    const rows = [...document.querySelectorAll("[class*='row-grid'][class*='cursor-pointer']")];
    rows.find((r) => r.textContent?.includes(wanted))?.click();
  }, subject);
  await page.waitForTimeout(900);
};

await page.goto(url);
await page.waitForTimeout(1500);

console.log("\nView mode over an HTML body");
await openSubject("HTML only");
await page.waitForTimeout(600);

await press("l");           // focus the detail pane
await press("Enter");       // enter view mode
await page.waitForTimeout(400);

const first = await frameSelection();
check("Enter puts a block cursor in the message", (first ?? "").length === 1, JSON.stringify(first));

await press("l", "l");
const moved = await frameSelection();
check("l moves it along the line", moved !== null && moved !== first, JSON.stringify(moved));

await press("w");
const word = await frameSelection();
check("w moves by word", (word ?? "").length === 1, JSON.stringify(word));

await press("j");
const down = await frameSelection();
check("j moves down a rendered line", down !== null, JSON.stringify(down));

console.log("\nSelecting and yanking");
await press("g", "g");
await press("v", "l", "l", "l");
const selected = await frameSelection();
check("v extends a selection", (selected ?? "").length === 4, JSON.stringify(selected));

await press("y");
const afterYank = await frameSelection();
check("y collapses back to a cursor", (afterYank ?? "").length === 1, JSON.stringify(afterYank));

const clipboard = await page.evaluate(() => navigator.clipboard?.readText().catch(() => null));
if (clipboard !== null && clipboard !== undefined) {
  check("the yank reached the system clipboard", clipboard.length > 0, JSON.stringify(clipboard));
} else {
  ok("the yank reached the system clipboard", "skipped: no clipboard permission");
}

console.log("\nFollowing a link");
await press("Escape");
await press("Enter");
await page.waitForTimeout(300);

// Put the cursor on the link text, then press Enter.
const foundLink = await page.evaluate(() => {
  const frame = document.querySelector('iframe[title="message body"]');
  return Boolean(frame?.contentDocument?.querySelector("a[href]"));
});
check("the fixture body has a link to aim at", foundLink);

await press("/");
await page.keyboard.type("a link");
await press("Enter");
await page.waitForTimeout(300);
const onLink = await frameSelection();
check("/ searches inside the message", onLink !== null, JSON.stringify(onLink));

const [popup] = await Promise.all([
  page.waitForEvent("popup", { timeout: 3000 }).catch(() => null),
  press("Enter"),
]);
check(
  "Enter on a link opens it",
  popup !== null && popup.url().includes("example.com/link"),
  popup ? popup.url() : "no window opened",
);
if (popup) await popup.close();

console.log("\nLeaving view mode");
await press("Escape");
await page.waitForTimeout(250);
const cleared = await frameSelection();
check("Escape clears the cursor", (cleared ?? "") === "", JSON.stringify(cleared));

// Leaving view mode has to hand the keyboard back: r must reply again.
await press("r");
await page.waitForTimeout(900);
const composerOpened = await page.evaluate(() =>
  Boolean(document.querySelector('textarea[aria-label="to field"]')),
);
check("keys go back to the application", composerOpened);

// Discard it, or the open draft swallows everything that follows.
await press("Escape", "Z", "Q");
await page.waitForTimeout(400);

console.log("\nView mode over a plain-text body");
await openSubject("Standalone email");
await page.waitForTimeout(700);
await press("l");
await press("Enter");
await page.waitForTimeout(400);

const plain = await paneSelection();
check("Enter puts a cursor in a plain-text message", (plain ?? "").length === 1, JSON.stringify(plain));

await press("v", "l", "l");
const plainSelected = await paneSelection();
check("visual mode works there too", (plainSelected ?? "").length === 3, JSON.stringify(plainSelected));

await press("Escape", "Escape");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
