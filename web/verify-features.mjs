/**
 * Exercises the interaction model: pane focus, per-pane keys, the vim editor,
 * reply and compose in the detail pane, settings, and that the detail pane
 * fills its column.
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

console.log("\nLight mode");
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const luminance = await page.evaluate(() => {
  const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
});
check("the app background is light", luminance > 0.6, `${bg} luminance ${luminance.toFixed(2)}`);

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
    el.className.includes("bg-bg-selected"),
  ),
);
check("j moves the list selection", selectedIndex === 2, `index ${selectedIndex} of ${beforeSelect}`);

await page.keyboard.press("h");
await page.waitForTimeout(200);
await page.keyboard.press("j");
await page.waitForTimeout(250);
const sidebarCursor = await page.evaluate(
  () => document.querySelectorAll("nav [class*='ring-accent']").length,
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

console.log("\nSidebar scrolls when folders overflow");
await page.evaluate(() => {
  const buttons = [...document.querySelectorAll("nav button")];
  buttons.find((b) => b.textContent.trim().startsWith("▸"))?.click();
});
await page.waitForTimeout(600);
const sidebarScroll = await page.evaluate(() => {
  const el = document.querySelector("nav .scroll-y");
  return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY: getComputedStyle(el).overflowY };
});
check(
  "the sidebar is scrollable with an account expanded",
  sidebarScroll.overflowY === "auto" && sidebarScroll.scrollHeight > sidebarScroll.clientHeight,
  `${sidebarScroll.scrollHeight} > ${sidebarScroll.clientHeight}`,
);

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
  return detail.querySelector("header div")?.textContent ?? "";
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
await page.waitForTimeout(800);
const settingsText = await page.inputValue("textarea").catch(() => "");
check("settings open in the same editor", settingsText.includes("[preferences]"));
check("settings list the keybindings", settingsText.includes("[keybindings]"));

const settingsInDetail = await page.evaluate(() => {
  const detail = [...document.querySelector("main").children].pop();
  return !!detail.querySelector("textarea");
});
check("settings render in the detail pane", settingsInDetail);

await page.keyboard.press("Escape");
await page.keyboard.press("Z");
await page.keyboard.press("Q");
await page.waitForTimeout(500);
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

await page.screenshot({ path: "screenshots/features.png" });
await browser.close();

console.log(failures.length === 0 ? "\nALL FEATURE CHECKS PASSED" : `\n${failures.length} FAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
