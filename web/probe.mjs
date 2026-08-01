import { chromium } from "playwright";
import { executablePath } from "./browser.mjs";

const [url] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });

page.on("console", (m) => m.type() === "error" && console.log("[console]", m.text().slice(0, 120)));
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 120)));
page.on("request", (r) => {
  if (r.url().includes("/tags")) console.log("[tag request]", r.method(), r.url().slice(-40));
});

await page.addInitScript((base) => {
  try {
    localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl: base, token: "" }));
    localStorage.setItem("ecr.settings", JSON.stringify({ preferences: { markReadDelay: 300 } }));
  } catch {}
}, url);

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector("[class*='row-grid'][class*='cursor-pointer']", { timeout: 20000 });
await page.waitForTimeout(1200);

await page.keyboard.press("Enter");
await page.waitForTimeout(3000);

const state = await page.evaluate(() => {
  const detail = [...document.querySelector("main").children].pop();
  const article = detail.querySelector("[data-message]");
  return {
    messageRendered: !!article,
    bodyRendered: !!(detail.querySelector("iframe") || detail.querySelector("pre")),
    settings: localStorage.getItem("ecr.settings"),
  };
});
console.log("state:", JSON.stringify(state));

const tags = await page.evaluate(async () => {
  const r = await (await fetch(`/api/v1/threads?q=tag:unread&limit=99&x=${Date.now()}`)).json();
  const all = await (await fetch(`/api/v1/threads?q=tag:inbox&limit=99&x=${Date.now()}`)).json();
  return { unread: r.total, inbox: all.total, firstTags: all.items[0]?.tags };
});
console.log("counts:", JSON.stringify(tags));

await browser.close();
