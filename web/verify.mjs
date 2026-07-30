/**
 * End-to-end verification against a running ecr-server + built web client.
 * Usage: node verify.mjs <webUrl> <serverUrl> <token>
 *
 * On NixOS Playwright's bundled chromium fails on libnspr4.so, so the system
 * Chrome is used instead.
 */
import { chromium } from "playwright";

const [webUrl, serverUrl, token] = process.argv.slice(2);
const failures = [];
const notes = [];

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

const browser = await chromium.launch({
  executablePath: "/run/current-system/sw/bin/google-chrome-stable",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

page.on("console", (m) => {
  if (m.type() === "error") notes.push(`console: ${m.text()}`);
});
page.on("pageerror", (e) => notes.push(`pageerror: ${e.message}`));

// This runs in every frame, including the sandboxed message iframe where
// localStorage is unreachable by design — that throw is the test's, not the app's.
await page.addInitScript(
  ([url, tok]) => {
    try {
      localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl: url, token: tok }));
    } catch {
      /* sandboxed iframe */
    }
  },
  [serverUrl, token],
);

console.log("\nLoading the client");
await page.goto(webUrl, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

check("page has no uncaught errors", notes.length === 0, notes.join(" | "));

console.log("\nThread list");
const rowCount = await page.locator("[class*='row-grid'][class*='cursor-pointer']").count();
check("thread rows render", rowCount > 0, `${rowCount} rows`);

const listText = await page.textContent("body");
check("a fixture subject is visible", listText.includes("Standalone email"));
check("the MIME fixture subject decoded", listText.includes("Hello"));

console.log("\nLayout: the bug that broke the egui client");
const overlap = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("[class*='row-grid']")];
  const problems = [];
  for (const row of rows) {
    const cells = [...row.children];
    for (let i = 0; i < cells.length - 1; i++) {
      const a = cells[i].getBoundingClientRect();
      const b = cells[i + 1].getBoundingClientRect();
      if (a.width > 0 && b.width > 0 && a.right > b.left + 1) {
        problems.push(`${Math.round(a.right - b.left)}px overlap`);
      }
    }
  }
  return problems;
});
check("no cells overlap horizontally", overlap.length === 0, overlap.slice(0, 3).join(", "));

const bodyOverflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
check("page does not scroll horizontally", bodyOverflow <= 0, `${bodyOverflow}px`);

console.log("\nTypography");
const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
check("body uses Cascadia Code", font.includes("Cascadia Code"), font);

const loaded = await page.evaluate(() =>
  [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
);
check("the webfont actually loaded", loaded.some((f) => f.includes("Cascadia")), loaded.join(","));

console.log("\nKeyboard navigation");
const selectedRow = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[class*='row-grid'][class*='cursor-pointer']")].findIndex(
      (el) => el.className.includes("bg-bg-selected"),
    ),
  );
const before = await selectedRow();
await page.keyboard.press("j");
await page.waitForTimeout(250);
const after = await selectedRow();
check("j moves the selection to the next row", after === before + 1, `${before} -> ${after}`);

await page.keyboard.press("Enter");
await page.waitForTimeout(900);
const afterOpen = await page.textContent("body");
check("Enter opens a thread", /message[s]?$/m.test(afterOpen) || afterOpen.includes("message"));

console.log("\nMessage body rendering");
const mimeRow = page.locator("text=Hello").first();
if (await mimeRow.count()) {
  await mimeRow.click();
  await page.waitForTimeout(1200);
}

const frame = page.frameLocator("iframe[title='message body']").first();
let frameHtml = "";
try {
  frameHtml = await frame.locator("body").innerHTML({ timeout: 4000 });
} catch {
  frameHtml = "";
}
check("the body renders in a sandboxed iframe", frameHtml.length > 0, `${frameHtml.length} chars`);
if (frameHtml) {
  check("no script survived sanitization", !frameHtml.includes("<script"));
  check("inline image points at the parts endpoint", frameHtml.includes("/parts/"));

  // A relative part URL resolves against the web origin inside a srcdoc frame,
  // so it must be absolute and carry the token — otherwise it silently 404s
  // and the reader sees a broken image.
  const images = await frame.locator("img").all();
  const loaded = [];
  for (const image of images) {
    loaded.push(
      await image.evaluate((el) => ({
        src: el.getAttribute("src") ?? "",
        ok: el.complete && el.naturalWidth > 0,
      })),
    );
  }
  const inline = loaded.filter((i) => i.src.includes("/parts/"));
  check(
    "the inline image actually loads",
    inline.length > 0 && inline.every((i) => i.ok),
    inline.map((i) => `${i.ok ? "ok" : "broken"} ${i.src.slice(0, 60)}`).join(", "),
  );
}

const sandbox = await page
  .getAttribute("iframe[title='message body']", "sandbox", { timeout: 3000 })
  .catch(() => null);
check(
  "iframe is sandboxed without same-origin",
  sandbox !== null && !sandbox.includes("allow-same-origin"),
  sandbox ?? "no iframe rendered",
);

console.log("\nCommand palette");
await page.keyboard.press("Escape");
await page.keyboard.press("/");
await page.waitForTimeout(300);
const paletteVisible = await page.locator("input").count();
check("search palette opens", paletteVisible > 0);
await page.keyboard.press("Escape");

console.log("\nHelp overlay");
await page.keyboard.press("?");
await page.waitForTimeout(300);
check("help lists keybindings", (await page.textContent("body")).includes("Keybindings"));

await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check(
  "escape closes the help overlay",
  !(await page.textContent("body")).includes("Escape or click outside"),
);

console.log("\nMobile layout");
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
const mobileOverflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
check("no horizontal scroll at 390px", mobileOverflow <= 0, `${mobileOverflow}px`);

const sidebarHidden = await page.evaluate(() => {
  const nav = document.querySelector("nav");
  if (!nav) return true;
  return nav.getBoundingClientRect().width === 0;
});
check("sidebar collapses on mobile", sidebarHidden);

await page.setViewportSize({ width: 1280, height: 860 });
await page.waitForTimeout(600);
await page.screenshot({ path: "screenshots/web-client.png", fullPage: false });

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await page.screenshot({ path: "screenshots/web-client-mobile.png", fullPage: false });
console.log("\nScreenshots written to screenshots/");

await browser.close();

console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} FAILED: ${failures.join(", ")}`}`);
if (notes.length) console.log(`notes:\n  ${notes.join("\n  ")}`);
process.exit(failures.length === 0 ? 0 : 1);
