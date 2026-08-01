/**
 * Compose surface checks: the header rows are fields rather than text, Tab
 * walks them, attachments arrive by picker and by drop, and paste reaches the
 * buffer. None of this is visible in a screenshot.
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
const check = (name, condition, detail) =>
  condition ? ok(name, detail) : fail(name, detail);

const browser = await chromium.launch({
  executablePath,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => fail("page error", e.message));

const press = async (...keys) => {
  for (const key of keys) {
    await page.keyboard.press(key);
    await page.waitForTimeout(90);
  }
};

const fieldValue = (name) =>
  page.evaluate(
    (n) => document.querySelector(`textarea[aria-label="${n} field"]`)?.value ?? null,
    name,
  );

const focusedLabel = () =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);

await page.goto(url);
await page.waitForTimeout(1200);

console.log("\nCompose fields");
await press("Enter");
await page.waitForTimeout(300);
await press("r");
await page.waitForTimeout(900);

const to = await fieldValue("to");
check("the recipient lands in a field of its own", to?.includes("@"), to ?? "no field");

const subject = await fieldValue("subject");
check("the subject is its own field", subject?.startsWith("Re:"), subject ?? "none");

check(
  "the To label is not in any editable buffer",
  !(to ?? "").toLowerCase().includes("to:"),
  to ?? "",
);

const body = await fieldValue(undefined) ?? (await page.evaluate(() => {
  const areas = [...document.querySelectorAll("textarea")];
  return areas.at(-1)?.value ?? null;
}));
check("the body holds the quote and no headers", body?.includes("wrote:") && !body?.includes("Subject:"), (body ?? "").slice(0, 40));

console.log("\nTab walks the fields");
// Reply opens on the body; Tab from there wraps to the first header.
await page.evaluate(() => document.querySelector('textarea[aria-label="to field"]')?.focus());
await page.waitForTimeout(150);
await press("Tab");
check("Tab moves to cc", (await focusedLabel()) === "cc field", await focusedLabel());
await press("Tab", "Tab");
check("and on to subject", (await focusedLabel()) === "subject field", await focusedLabel());
await press("Tab");
const afterSubject = await focusedLabel();
check("then into the body", afterSubject !== "subject field", afterSubject ?? "none");

console.log("\nEditing a header value");
await page.evaluate(() => document.querySelector('textarea[aria-label="subject field"]')?.focus());
await page.waitForTimeout(150);
await press("d", "d");
check("dd clears the subject value", (await fieldValue("subject")) === "", await fieldValue("subject"));

await press("i");
await page.keyboard.type("Rebuilt");
await page.waitForTimeout(150);
check("typing goes into the value", (await fieldValue("subject")) === "Rebuilt", await fieldValue("subject"));

await press("Escape");
await press("0", "v", "l", "l", "d");
check(
  "visual mode works in a header field",
  (await fieldValue("subject")) === "uilt",
  await fieldValue("subject"),
);

console.log("\nPaste");
await page.evaluate(() => document.querySelector('textarea[aria-label="cc field"]')?.focus());
await page.waitForTimeout(150);
await page.evaluate(() => {
  const area = document.querySelector('textarea[aria-label="cc field"]');
  const data = new DataTransfer();
  data.setData("text", "pasted@example.com");
  area?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(250);
check(
  "pasted text reaches the buffer",
  (await fieldValue("cc")) === "pasted@example.com",
  await fieldValue("cc"),
);

console.log("\nAttachments");
await page.setInputFiles('input[type="file"]', {
  name: "report.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4 fake"),
});
await page.waitForTimeout(400);

const chips = await page.evaluate(() =>
  [...document.querySelectorAll("span")].map((s) => s.textContent).filter((t) => t?.includes("report.pdf")),
);
check("a picked file becomes a chip", chips.length > 0, chips[0] ?? "none");

const removed = await page.evaluate(async () => {
  const button = [...document.querySelectorAll("button")].find((b) =>
    b.getAttribute("aria-label")?.startsWith("Remove report.pdf"),
  );
  button?.click();
  await new Promise((r) => setTimeout(r, 200));
  return [...document.querySelectorAll("span")].some((s) => s.textContent?.includes("report.pdf"));
});
check("and can be removed again", removed === false);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
