/** The second round of interaction work, against real mail. */
import { chromium } from "playwright";
import { executablePath } from "./browser.mjs";

const [url] = process.argv.slice(2);
const failures = [];
const notes = [];

function check(name, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

const browser = await chromium.launch({
  executablePath,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });

page.on("pageerror", (e) => notes.push(e.message.slice(0, 140)));
page.on("console", (m) => m.type() === "error" && notes.push(m.text().slice(0, 140)));

await page.addInitScript((base) => {
  try {
    localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl: base, token: "" }));
    localStorage.removeItem("ecr.settings");
  } catch {
    /* sandboxed */
  }
}, url);

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector("[class*='row-grid'][class*='cursor-pointer']", { timeout: 20000 });
await page.waitForTimeout(1500);

const rowSelector = "[class*='row-grid'][class*='cursor-pointer']";
const footer = (n) => page.textContent(`footer span:nth-child(${n})`);
const openSubject = () =>
  page.evaluate(() => {
    const detail = [...document.querySelector("main").children].pop();
    return detail.querySelector("h1")?.textContent ?? "";
  });

console.log("\nSelection drives the detail pane");
await page.keyboard.press("j");
await page.waitForTimeout(1800);
const first = await openSubject();
check("moving the cursor opens that thread", first.length > 0, first.slice(0, 44));

await page.keyboard.press("j");
await page.waitForTimeout(1800);
const second = await openSubject();
check("moving again opens the next thread", second !== first, second.slice(0, 44));

console.log("\nAccount-scoped views");
const sidebarText = await page.textContent("nav");
check("the sidebar offers an all-accounts group", sidebarText.toLowerCase().includes("all accounts"));
const health = await fetch(`${url}/api/v1/health`).then((r) => r.json());
check("the server reports at least one account", health.accounts.length > 0);
for (const account of health.accounts.map((a) => a.id)) {
  check(`the sidebar has a ${account} group`, sidebarText.includes(account));
}

check("the footer names the account", (await footer(3)).length > 0, await footer(3));

await page.evaluate(() => {
  const groups = [...document.querySelectorAll("nav button")];
  groups.find((b) => b.textContent.toLowerCase().includes("main"))?.click();
});
await page.waitForTimeout(1800);
const scoped = await page.inputValue("header input");
check("choosing an account scopes the query", scoped.includes("tag:main"), scoped);
check("the footer follows the account", (await footer(3)).includes("@"), await footer(3));

const views = await page.textContent("nav");
check("the account group lists every view", views.includes("UNREAD") && views.includes("FLAGGED"));

console.log("\nCtrl chords move panes");
await page.keyboard.down("Control");
await page.keyboard.press("h");
await page.keyboard.up("Control");
await page.waitForTimeout(250);
check("ctrl+h moves focus left", (await footer(2)).trim() === "sidebar", await footer(2));

await page.keyboard.down("Control");
await page.keyboard.press("l");
await page.keyboard.up("Control");
await page.waitForTimeout(250);
check("ctrl+l moves focus right", (await footer(2)).trim() === "list", await footer(2));

console.log("\nQuery prompt with suggestions");
await page.keyboard.press("/");
await page.waitForTimeout(400);
await page.keyboard.type("tag:un");
await page.waitForTimeout(600);

const suggestionText = await page.evaluate(() => {
  const list = document.querySelector("ul.max-h-72");
  return list ? list.textContent : "";
});
check("suggestions appear while typing a query", suggestionText.includes("unread"), suggestionText.slice(0, 60));

await page.keyboard.press("Enter");
await page.waitForTimeout(2000);
check("choosing a suggestion runs it", (await page.inputValue("header input")).includes("tag:unread"));

console.log("\nCompose is pinned below the thread");
await page.keyboard.press("Escape");
await page.keyboard.press("l");
await page.waitForTimeout(300);
await page.keyboard.press("j");
await page.waitForTimeout(1800);
await page.keyboard.press("r");
await page.waitForTimeout(1500);

const layout = await page.evaluate(() => {
  const detail = [...document.querySelector("main").children].pop();
  const section = detail.querySelector("section");
  const textarea = section.querySelector("textarea");
  const iframe = section.querySelector("iframe[title='message body']");
  return {
    hasEditor: !!textarea,
    hasThread: !!iframe,
    editorTop: textarea?.getBoundingClientRect().top ?? 0,
    threadTop: iframe?.getBoundingClientRect().top ?? 0,
  };
});
check("the composer is open", layout.hasEditor);
check("the thread is still visible while composing", layout.hasThread);
check("the composer sits below the thread", layout.editorTop > layout.threadTop, `${Math.round(layout.threadTop)} vs ${Math.round(layout.editorTop)}`);

console.log("\nThe editor starts in normal mode");
const startMode = await page.evaluate(() => {
  const spans = [...document.querySelectorAll("span")];
  return spans.find((s) => ["normal", "insert"].includes(s.textContent.trim()))?.textContent.trim();
});
check("compose opens in normal mode", startMode === "normal", startMode);

console.log("\nCtrl+p minimises the pinned split");
await page.keyboard.down("Control");
await page.keyboard.press("p");
await page.keyboard.up("Control");
await page.waitForTimeout(500);
check("ctrl+p hides the composer", (await page.locator("textarea").count()) === 0);
check("the draft is not lost", (await page.textContent("body")).includes("minimised"));

await page.keyboard.down("Control");
await page.keyboard.press("p");
await page.keyboard.up("Control");
await page.waitForTimeout(500);
check("ctrl+p brings it back", (await page.locator("textarea").count()) === 1);

console.log("\nReading while composing");
await page.keyboard.down("Control");
await page.keyboard.press("h");
await page.keyboard.up("Control");
await page.waitForTimeout(300);
check("ctrl+h leaves the composer without closing it", (await page.locator("textarea").count()) === 1);
check("focus moved to the list", (await footer(2)).trim() === "list", await footer(2));

await page.keyboard.press("j");
await page.waitForTimeout(1800);
check("mail can still be browsed while the draft is open", (await page.locator("textarea").count()) === 1);

console.log("\nRecipient suggestions");
await page.keyboard.down("Control");
await page.keyboard.press("l");
await page.keyboard.up("Control");
await page.waitForTimeout(300);
await page.click("textarea");
await page.keyboard.press("g");
await page.keyboard.press("g");
await page.keyboard.press("A");
await page.waitForTimeout(200);
await page.keyboard.type(", lok");
await page.waitForTimeout(800);

const addressList = await page.evaluate(() => {
  const lists = [...document.querySelectorAll("ul")];
  const match = lists.find((l) => l.textContent.includes("@"));
  return match ? match.textContent : "";
});
check("recipient suggestions appear", addressList.includes("@"), addressList.slice(0, 60));

await page.screenshot({ path: "screenshots/live/v2-compose.png" });

console.log("\nSettings");
await page.keyboard.press("Escape");
await page.keyboard.press("Z");
await page.keyboard.press("Q");
await page.waitForTimeout(600);
await page.keyboard.press(",");
await page.waitForTimeout(1000);

const settingsBody = await page.textContent("body");
check("the packages tab renders", settingsBody.includes("notmuch") && settingsBody.includes("self-managed"));
check("every package is listed", ["mbsync", "vdirsyncer", "imapnotify", "msmtp"].every((p) => settingsBody.includes(p)));

// A self-managed package offers no config field at all, rather than a
// disabled one: there is nothing to edit and the stored value is ignored.
const editable = await page.evaluate(() => document.querySelectorAll("textarea").length);
check("self-managed packages offer no config field", editable === 0, `${editable} fields`);
check(
  "and say why",
  (await page.textContent("main")).includes("never writes it"),
);

await page.evaluate(() => {
  const buttons = [...document.querySelectorAll("button")];
  buttons.find((b) => b.textContent.trim() === "managed by ecr")?.click();
});
await page.waitForTimeout(700);
const afterEnable = await page.evaluate(() => document.querySelectorAll("textarea").length);
check("switching to ecr-managed reveals its config", afterEnable === 1, `${afterEnable} fields`);

await page.screenshot({ path: "screenshots/live/v2-settings.png" });

check("no page errors throughout", notes.length === 0, notes.slice(0, 2).join(" | "));

await browser.close();
console.log(failures.length === 0 ? "\nALL V2 CHECKS PASSED" : `\n${failures.length} FAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
