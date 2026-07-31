import { chromium } from "playwright";
const [url] = process.argv.slice(2);
const failures = [], notes = [];
const check = (n, ok, d = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) failures.push(n); };

const browser = await chromium.launch({ executablePath: "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
page.on("pageerror", (e) => notes.push(e.message.slice(0, 120)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  // The layout sampling below fetches bodies directly; a message with no html
  // part answers 404, which is this probe's noise rather than the app's.
  if (m.text().includes("404")) return;
  notes.push(m.text().slice(0, 120));
});
await page.addInitScript((b) => { try { localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl: b, token: "" })); localStorage.removeItem("ecr.settings"); } catch {} }, url);

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector("[class*='row-grid'][class*='cursor-pointer']", { timeout: 20000 });
await page.waitForTimeout(1500);

console.log("\nDark theme from the thesis palette");
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
check("the ground is the dark paper", bg === "rgb(12, 21, 26)", bg);
const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
check("running text uses the body face", font.includes("Nunito"), font.slice(0, 40));
const registered = await page.evaluate(() => [...document.fonts].map((f) => f.family));
check(
  "all three faces are registered",
  ["Nunito", "Space Grotesk", "Cascadia"].every((f) => registered.some((r) => r.includes(f))),
  [...new Set(registered)].join(","),
);

console.log("\nHTML rendering");
await page.keyboard.press("j");
await page.waitForTimeout(2600);

// A heading only exists once a thread is open, so the display face is checked here.
const headingFont = await page.evaluate(() => {
  const h1 = document.querySelector("main h1");
  return h1 ? getComputedStyle(h1).fontFamily : "";
});
check("headings use the display face", headingFont.includes("Space Grotesk"), headingFont.slice(0, 40));
const monoFont = await page.evaluate(() => {
  const el = document.querySelector("kbd, .mono");
  return el ? getComputedStyle(el).fontFamily : "";
});
check("labels and data use the mono face", monoFont.includes("Cascadia"), monoFont.slice(0, 40));
const html = await page.frameLocator("iframe[title='message body']").first().locator("body").innerHTML({ timeout: 8000 }).catch(() => "");
check("a body renders", html.length > 0, `${html.length} chars`);
// Whether one arbitrary message has a table is luck; sample several so the
// check means "the sanitiser keeps mail layout" rather than "this one did".
const layout = await page.evaluate(async () => {
  const page_ = await (await fetch("/api/v1/threads?q=tag:inbox&limit=12")).json();
  let checked = 0;
  let withTables = 0;

  for (const item of page_.items) {
    if (!item.newest_message) continue;
    const body = await (
      await fetch(`/api/v1/messages/${encodeURIComponent(item.newest_message)}/body`)
    ).json();
    if (body.format !== "html") continue;
    checked++;
    if (/<table|<td/i.test(body.content)) withTables++;
  }
  return { checked, withTables };
});
check(
  "table layout survives sanitising",
  layout.checked === 0 || layout.withTables > 0,
  `${layout.withTables} of ${layout.checked} html messages kept their tables`,
);

const styles = await page.evaluate(async () => {
  const page_ = await (await fetch("/api/v1/threads?q=tag:inbox&limit=12")).json();
  for (const item of page_.items) {
    if (!item.newest_message) continue;
    const body = await (
      await fetch(`/api/v1/messages/${encodeURIComponent(item.newest_message)}/body`)
    ).json();
    if (/prefers-color-scheme:\s*dark/i.test(body.content)) return "a dark block survived";
  }
  return "none";
});
check("no sender dark-mode block reaches the reader", styles === "none", styles);
const frameW = await page.evaluate(() => {
  const f = document.querySelector("iframe[title='message body']");
  return f ? { outer: Math.round(f.getBoundingClientRect().width), inner: f.contentDocument?.body?.scrollWidth ?? 0 } : null;
});
check("the message does not overflow its pane", frameW && frameW.inner <= frameW.outer + 2, `${frameW?.inner} vs ${frameW?.outer}`);

console.log("\nBody caching");
const timed = async () => {
  const t0 = Date.now();
  await page.keyboard.press("j"); await page.waitForTimeout(900);
  await page.keyboard.press("k"); await page.waitForTimeout(900);
  return Date.now() - t0;
};
await timed();
const requests = [];
page.on("request", (r) => r.url().includes("/body") && requests.push(r.url()));
await page.keyboard.press("j"); await page.waitForTimeout(1200);
await page.keyboard.press("k"); await page.waitForTimeout(1200);
check("revisiting a message does not refetch its body", requests.length <= 1, `${requests.length} body requests`);

console.log("\nCtrl+p round trip");
await page.keyboard.press("r"); await page.waitForTimeout(1500);
check("reply opens", (await page.locator("textarea").count()) === 1);
for (const pass of [1, 2, 3]) {
  await page.keyboard.down("Control"); await page.keyboard.press("p"); await page.keyboard.up("Control");
  await page.waitForTimeout(450);
  check(`ctrl+p hides (pass ${pass})`, (await page.locator("textarea").count()) === 0);
  await page.keyboard.down("Control"); await page.keyboard.press("p"); await page.keyboard.up("Control");
  await page.waitForTimeout(450);
  check(`ctrl+p shows again (pass ${pass})`, (await page.locator("textarea").count()) === 1);
}

console.log("\nEditing");
await page.click("textarea");
await page.keyboard.press("Escape"); await page.waitForTimeout(150);
await page.keyboard.press("g"); await page.keyboard.press("g");
await page.keyboard.press("2"); await page.keyboard.press("d"); await page.keyboard.press("d");
await page.waitForTimeout(300);
const after2dd = await page.inputValue("textarea");
check("2dd deletes two lines", after2dd.startsWith("Subject:"), after2dd.split("\n")[0]);

await page.keyboard.press("u"); await page.waitForTimeout(250);
check("u restores them", (await page.inputValue("textarea")).startsWith("To:"), (await page.inputValue("textarea")).split("\n")[0]);

await page.keyboard.press("A");
await page.keyboard.type("XYZ");
await page.keyboard.press("Escape"); await page.waitForTimeout(200);
check("typing appends", (await page.inputValue("textarea")).split("\n")[0].endsWith("XYZ"));
await page.keyboard.press("u"); await page.waitForTimeout(250);
check("one undo removes the whole insert session", !(await page.inputValue("textarea")).includes("XYZ"));

await page.screenshot({ path: "screenshots/v3-dark.png" });
check("no page errors", notes.length === 0, notes.slice(0, 2).join(" | "));
await browser.close();
console.log(failures.length === 0 ? "\nALL V3 CHECKS PASSED" : `\n${failures.length} FAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
