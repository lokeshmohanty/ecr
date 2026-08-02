/**
 * Selecting rows and staging tags on them. Two-phase by design: nothing is
 * written until x, so the staged state has to be visible first.
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => fail("page error", e.message));

const press = async (...keys) => {
  for (const key of keys) {
    await page.keyboard.press(key);
    await page.waitForTimeout(110);
  }
};

/** The staged badge on each row, in order. */
const badges = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[class*='row-grid'][class*='cursor-pointer']")].map(
      (row) => row.querySelector("span.mono")?.textContent ?? "",
    ),
  );

const tapes = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[class*='row-grid'][class*='cursor-pointer']")].map((row) => {
      const tape = row.querySelector(".tape");
      return tape ? tape.className.replace("tape", "").trim() : "";
    }),
  );

/** The row's class list, in order, so a range is read by its background, not its tape. */
const rowClasses = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[class*='row-grid'][class*='cursor-pointer']")].map(
      (row) => row.className,
    ),
  );

const status = () =>
  page.evaluate(() => document.querySelector("footer")?.textContent ?? "");

await page.goto(url);
await page.waitForTimeout(1500);

console.log("\nSelecting rows");
await press("Space");
let marked = await tapes();
check("Space selects the row under the cursor", marked[0]?.includes("tape-selected"), marked[0]);

await press("j", "Space");
marked = await tapes();
check("a second row can be picked", marked[1]?.includes("tape-selected"), marked[1]);

await press("Space");
marked = await tapes();
check("Space again unpicks it", !marked[1]?.includes("tape-selected"), marked[1]);

console.log("\nA visual range");
await press("X");
await press("v", "j", "j");
let rows = await rowClasses();
const inRange = rows.filter((c) => {
  const set = new Set(c.split(/\s+/));
  return set.has("bg-obligation-bg") || set.has("bg-neutral-bg");
}).length;
check("v extends a range as the cursor moves", inRange === 3, `${inRange} rows`);

marked = await tapes();
check(
  "the range shows no tape (only picks do)",
  marked.every((t) => !t.includes("tape-selected")),
  marked.join("|"),
);

console.log("\nSpace picks a visual range");
await press("X");
await press("v", "j", "j");
await press("Space");
marked = await tapes();
const pickedCount = marked.filter((t) => t.includes("tape-selected")).length;
check("Space picks every row in the range", pickedCount === 3, `${pickedCount} picked`);

await press("Space");
marked = await tapes();
const unpickedCount = marked.filter((t) => t.includes("tape-selected")).length;
check("Space again unpicks the range", unpickedCount === 0, `${unpickedCount} picked`);

await press("Escape");
rows = await rowClasses();
const afterEscape = rows.filter((c) => {
  const set = new Set(c.split(/\s+/));
  return set.has("bg-obligation-bg") || set.has("bg-neutral-bg");
}).length;
check("Escape abandons the range", afterEscape === 1, `${afterEscape} highlighted`);

console.log("\nStaging on a selection");
await press("g", "g");
await press("v", "j");
await press("d");
let staged = await badges();
check("d stages a delete on every selected row", staged[0] === "D" && staged[1] === "D", staged.join("|"));

await press("X");
staged = await badges();
check("X clears what was staged", staged.every((b) => b === ""), staged.join("|"));

console.log("\nStaging any tag");
await press("g", "g");
await press("Space", "j", "Space");
await press("t");
await page.waitForTimeout(300);

const promptOpen = await page.evaluate(() =>
  Boolean(document.querySelector('input[aria-label="tags"]')),
);
check("t opens a tag prompt", promptOpen);

await page.keyboard.type("+holiday -inbox");
await press("Enter");
await page.waitForTimeout(300);

staged = await badges();
check("the tag is staged on both rows", staged[0] === "T" && staged[1] === "T", staged.join("|"));

console.log("\nApplying");
await press("x");
await page.waitForTimeout(1200);

staged = await badges();
check("x clears the queue once written", staged.every((b) => b === ""), staged.join("|"));

const applied = await status();
check("and says what it did", /applied/.test(applied), /applied \d+/.exec(applied)?.[0] ?? applied.slice(0, 40));

// The client is served from the API's own origin here, so a relative URL is
// the same server the app just wrote through.
const holiday = await page.evaluate(async () => {
  const response = await fetch(`/api/v1/threads?q=${encodeURIComponent("tag:holiday")}`);
  if (!response.ok) return [];
  const page = await response.json();
  return (page.items ?? []).map((t) => t.subject);
});
check(
  "the tag really reached notmuch, on both threads",
  holiday.length === 2,
  holiday.join(" | ") || "none",
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
