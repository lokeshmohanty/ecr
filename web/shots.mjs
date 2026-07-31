import { chromium } from "playwright";

const [url] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: "/run/current-system/sw/bin/google-chrome-stable",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });

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

await page.keyboard.press("Enter");
await page.waitForTimeout(3500);
await page.screenshot({ path: "screenshots/light-reading.png" });

await page.keyboard.press("r");
await page.waitForTimeout(1600);
await page.screenshot({ path: "screenshots/light-reply.png" });

await page.keyboard.press("Escape");
await page.keyboard.press("Z");
await page.keyboard.press("Q");
await page.waitForTimeout(700);

await page.keyboard.press(",");
await page.waitForTimeout(1300);
await page.screenshot({ path: "screenshots/light-settings.png" });

await browser.close();
console.log("screenshots written");
