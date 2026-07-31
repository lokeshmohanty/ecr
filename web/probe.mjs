import { chromium } from "playwright";

const [url] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: "/run/current-system/sw/bin/google-chrome-stable",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.addInitScript((base) => {
  try {
    localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl: base, token: "" }));
    localStorage.removeItem("ecr.settings");
  } catch {}
}, url);

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector("[class*='row-grid'][class*='cursor-pointer']", { timeout: 20000 });
await page.waitForTimeout(1500);

const rowClasses = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[class*='row-grid'][class*='cursor-pointer']")]
      .slice(0, 4)
      .map((r) => r.className),
  );

console.log("before:", JSON.stringify(await rowClasses(), null, 1));
await page.keyboard.press("j");
await page.waitForTimeout(700);
console.log("after j:", JSON.stringify(await rowClasses(), null, 1));

await browser.close();
