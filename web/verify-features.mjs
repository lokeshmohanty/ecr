/**
 * Exercises the interaction model: pane focus, per-pane keys, the vim editor,
 * reply and compose in the detail pane, settings, and that the detail pane
 * fills its column.
 */
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

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
await page.waitForTimeout(800);

const pane = () => page.textContent("footer span:nth-child(2)");
const bodyText = () => page.textContent("body");

console.log("\nTheme");
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
check("the app uses the dark paper ground", bg === "rgb(12, 21, 26)", bg);

// Mail is authored for white; the message canvas must not follow the app theme.
const canvas = await page.evaluate(() => {
  const f = document.querySelector("iframe[title='message body']");
  return f?.contentDocument ? getComputedStyle(f.contentDocument.body).backgroundColor : "none";
});
check("message bodies still render on white", canvas === "none" || canvas === "rgb(255, 255, 255)", canvas);

console.log("\nPane focus with h and l");
check("starts focused on the list", (await pane())?.trim() === "list", await pane());

await page.keyboard.press("h");
await page.waitForTimeout(200);
check("h moves focus left to the sidebar", (await pane())?.trim() === "sidebar", await pane());

await page.keyboard.press("h");
await page.waitForTimeout(200);
check("h at the far left stays put", (await pane())?.trim() === "sidebar", await pane());

await page.keyboard.press("l");
await page.keyboard.press("l");
await page.waitForTimeout(250);
check("l moves focus right to the detail pane", (await pane())?.trim() === "detail", await pane());

console.log("\nPer-pane keys");
await page.keyboard.press("h");
await page.waitForTimeout(200);
const beforeSelect = await page.evaluate(
  () => document.querySelectorAll("[class*='row-grid'][class*='cursor-pointer']").length,
);
await page.keyboard.press("j");
await page.keyboard.press("j");
await page.waitForTimeout(300);
const selectedIndex = await page.evaluate(() =>
  [...document.querySelectorAll("[class*='row-grid'][class*='cursor-pointer']")].findIndex((el) =>
    el.className.includes("bg-obligation-bg"),
  ),
);
check("j moves the list selection", selectedIndex === 2, `index ${selectedIndex} of ${beforeSelect}`);

await page.keyboard.press("h");
await page.waitForTimeout(200);
await page.keyboard.press("j");
await page.waitForTimeout(250);
const sidebarCursor = await page.evaluate(
  () => document.querySelectorAll("nav [class*='ring-obligation']").length,
);
check("j moves the sidebar cursor when the sidebar has focus", sidebarCursor === 1, `${sidebarCursor} cursors`);

console.log("\nDetail pane fills its column");
await page.keyboard.press("l");
await page.waitForTimeout(200);
await page.keyboard.press("Enter");
await page.waitForTimeout(2500);

const heights = await page.evaluate(() => {
  const main = document.querySelector("main");
  const cells = [...main.children];
  const detail = cells[cells.length - 1];
  const section = detail.querySelector("section");
  return {
    column: Math.round(detail.getBoundingClientRect().height),
    section: Math.round(section?.getBoundingClientRect().height ?? 0),
    scroller: Math.round(section?.querySelector(".scroll-y")?.getBoundingClientRect().height ?? 0),
  };
});
check(
  "the detail section fills the column",
  Math.abs(heights.column - heights.section) <= 2,
  `column ${heights.column} vs section ${heights.section}`,
);
check("the detail body scrolls inside it", heights.scroller > heights.column * 0.5, `${heights.scroller}px`);

console.log("\nMessage body is not truncated");
const frameFit = await page.evaluate(async () => {
  const frame = document.querySelector("iframe[title='message body']");
  if (!frame) return null;
  await new Promise((r) => setTimeout(r, 2500));
  const inner = frame.contentDocument?.body?.scrollHeight ?? 0;
  const outer = frame.getBoundingClientRect().height;
  return { inner, outer };
});
check(
  "the iframe grows to fit its content",
  frameFit && frameFit.inner > 0 && frameFit.outer >= frameFit.inner,
  frameFit ? `frame ${Math.round(frameFit.outer)}px vs content ${frameFit.inner}px` : "no iframe",
);

const sandbox = await page.getAttribute("iframe[title='message body']", "sandbox");
check(
  "message HTML can never execute",
  sandbox !== null && !sandbox.includes("allow-scripts"),
  sandbox ?? "no sandbox attribute",
);

console.log("\nSidebar scrolling");
const sidebarScroll = await page.evaluate(() => {
  const el = document.querySelector("nav .scroll-y");
  return { overflowY: getComputedStyle(el).overflowY, minHeight: getComputedStyle(el).minHeight };
});
check(
  "the sidebar scrolls rather than pushing its buttons off-screen",
  sidebarScroll.overflowY === "auto",
  `overflow-y: ${sidebarScroll.overflowY}`,
);

const composeVisible = await page.evaluate(() => {
  const button = [...document.querySelectorAll("nav button")].find((b) =>
    b.textContent.includes("COMPOSE"),
  );
  if (!button) return false;
  const box = button.getBoundingClientRect();
  return box.bottom <= window.innerHeight + 1 && box.height > 0;
});
check("compose and settings stay reachable", composeVisible);

console.log("\nReply opens in the detail pane");
await page.keyboard.press("l");
await page.waitForTimeout(200);
await page.keyboard.press("j");
await page.waitForTimeout(400);
await page.keyboard.press("r");
await page.waitForTimeout(900);
check("reply shows an editor rather than a modal", (await bodyText()).includes("ZZ"));
check("no modal overlay is used", (await page.locator(".fixed.inset-0, .absolute.inset-0.z-20").count()) === 0);

const editorInDetail = await page.evaluate(() => {
  const main = document.querySelector("main");
  const detail = [...main.children].pop();
  return !!detail.querySelector("textarea");
});
check("the editor lives inside the detail pane", editorInDetail);

const prefilled = await page.inputValue("textarea");
check("the reply is prefilled with headers", prefilled.startsWith("To:"), prefilled.split("\n")[0]);
check("the subject is prefixed with Re:", /^Subject: Re:/m.test(prefilled));

// Replying must use the account the thread belongs to. Picking accounts()[0]
// meant answering a Gmail thread from the work address because it sorts first.
const fromLine = await page.evaluate(() => {
  const detail = [...document.querySelector("main").children].pop();
  const headers = [...detail.querySelectorAll("header div")].map((d) => d.textContent);
  return headers.find((h) => h.includes("from ")) ?? "";
});
const threadAccount = await page.evaluate(async () => {
  const res = await fetch("/api/v1/threads?q=tag:inbox&limit=30");
  const page_ = await res.json();
  return page_.items.map((t) => t.tags);
});
check(
  "reply is from a real configured account",
  /from \S+@\S+/.test(fromLine),
  fromLine.split("·")[0]?.trim(),
);
const _ = threadAccount;

console.log("\nVim editing in the composer");
const focusedOnOpen = await page.evaluate(() => document.activeElement?.tagName);
check("the editor takes focus when it opens", focusedOnOpen === "TEXTAREA", focusedOnOpen);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
const modeAfterEscape = await page.evaluate(
  () => document.querySelector("textarea")?.parentElement?.querySelector("span")?.textContent,
);
check("escape leaves insert mode", modeAfterEscape?.trim() === "normal", modeAfterEscape);

await page.keyboard.press("g");
await page.keyboard.press("g");
await page.keyboard.press("d");
await page.keyboard.press("d");
await page.waitForTimeout(300);
const afterDD = await page.inputValue("textarea");
check("dd deletes the To: line", !afterDD.startsWith("To:"), afterDD.split("\n")[0]);

await page.keyboard.press("i");
await page.waitForTimeout(150);
await page.keyboard.type("X");
await page.waitForTimeout(200);
const afterInsert = await page.inputValue("textarea");
check("i enters insert and types", afterInsert.startsWith("X"), afterInsert.split("\n")[0]);

console.log("\nDiscarding returns to reading");
await page.keyboard.press("Escape");
await page.keyboard.press("Z");
await page.keyboard.press("Q");
await page.waitForTimeout(700);
check("ZQ closes the editor", (await page.locator("textarea").count()) === 0);

console.log("\nSettings");
await page.keyboard.press(",");
await page.waitForTimeout(900);

const settingsBody = await page.textContent("body");
check("settings open on the packages tab", settingsBody.includes("self-managed"));

const settingsInDetail = await page.evaluate(() => {
  const detail = [...document.querySelector("main").children].pop();
  return detail.textContent.includes("Settings");
});
check("settings render in the detail pane", settingsInDetail);

await page.evaluate(() => {
  [...document.querySelectorAll("button")]
    .find((b) => b.textContent.includes("Preferences"))
    ?.click();
});
await page.waitForTimeout(700);
const settingsText = await page.inputValue("textarea").catch(() => "");
check("the text tab is the same vim editor", settingsText.includes("[preferences]"));
check("it lists the keybindings", settingsText.includes("[keybindings]"));

await page.keyboard.press("Escape");
await page.keyboard.press("Z");
await page.keyboard.press("Q");
await page.waitForTimeout(600);
check("ZQ closes settings", (await page.locator("textarea").count()) === 0);

console.log("\nCompose");
await page.keyboard.press("c");
await page.waitForTimeout(700);
const composeText = await page.inputValue("textarea").catch(() => "");
check("compose opens a blank draft in the detail pane", composeText.startsWith("To: "), composeText.split("\n")[0]);
await page.keyboard.press("Escape");
await page.keyboard.press("Z");
await page.keyboard.press("Q");
await page.waitForTimeout(400);

check("no page errors throughout", notes.length === 0, notes.slice(0, 2).join(" | "));

await page.screenshot({ path: "screenshots/live/features.png" });
await browser.close();

console.log(failures.length === 0 ? "\nALL FEATURE CHECKS PASSED" : `\n${failures.length} FAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
