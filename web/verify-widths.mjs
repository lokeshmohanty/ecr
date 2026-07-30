/**
 * The row layout has to hold at every width the app is actually used at,
 * including the desktop window's default and a narrow split.
 */
import { chromium } from "playwright";

const [url] = process.argv.slice(2);
const WIDTHS = [1920, 1440, 1280, 1024, 950, 820, 768, 600, 480, 390, 360, 320];
const failures = [];

const browser = await chromium.launch({
  executablePath: "/run/current-system/sw/bin/google-chrome-stable",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.addInitScript((base) => {
  try {
    localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl: base, token: "" }));
  } catch {
    /* sandboxed */
  }
}, url);

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector("[class*='row-grid'][class*='cursor-pointer']", { timeout: 20000 });

for (const width of WIDTHS) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(350);

  const report = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[class*='row-grid'][class*='cursor-pointer'])".replace(")", ""))];
    let horizontal = 0;
    let vertical = 0;
    let clipped = 0;

    for (const row of rows.slice(0, 25)) {
      const cells = [...row.children];
      for (let i = 0; i < cells.length - 1; i++) {
        const a = cells[i].getBoundingClientRect();
        const b = cells[i + 1].getBoundingClientRect();
        if (a.width > 0 && b.width > 0 && a.right > b.left + 1) horizontal++;
      }
      // Content taller than the row bleeds into the row below.
      if (row.scrollHeight > row.clientHeight + 1) vertical++;
      for (const cell of cells) {
        if (cell.scrollWidth > cell.clientWidth + 1 && !cell.className.includes("truncate")) {
          clipped++;
        }
      }
    }

    return {
      rows: rows.length,
      horizontal,
      vertical,
      clipped,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  const ok =
    report.horizontal === 0 && report.vertical === 0 && report.overflow <= 0 && report.rows > 0;
  if (!ok) failures.push(`${width}px`);

  console.log(
    `  ${ok ? "ok  " : "FAIL"} ${String(width).padStart(4)}px  ` +
      `rows=${report.rows} sideBySideOverlap=${report.horizontal} ` +
      `rowOverflow=${report.vertical} pageOverflow=${report.overflow}px`,
  );
}

await page.setViewportSize({ width: 950, height: 1000 });
await page.waitForTimeout(400);
await page.screenshot({ path: "screenshots/width-950.png" });

await browser.close();
console.log(failures.length === 0 ? "\nLAYOUT HOLDS AT EVERY WIDTH" : `\nFAILED AT: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
