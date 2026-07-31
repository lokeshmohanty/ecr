import { chromium } from "playwright";

const [url, query] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: "/run/current-system/sw/bin/google-chrome-stable",
  args: ["--no-sandbox"],
});
// Match the user's environment: an OS-level dark preference.
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: "dark" });

await page.addInitScript((base) => {
  try {
    localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl: base, token: "" }));
    localStorage.removeItem("ecr.settings");
  } catch {}
}, url);

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector("[class*='row-grid'][class*='cursor-pointer']", { timeout: 20000 });

await page.keyboard.press("/");
await page.waitForTimeout(300);
await page.keyboard.type(query);
await page.keyboard.press("Enter");
await page.waitForTimeout(2500);

await page.keyboard.press("Enter");
await page.waitForTimeout(3500);

const report = await page.evaluate(() => {
  const frame = document.querySelector("iframe[title='message body']");
  const doc = frame?.contentDocument;
  if (!doc?.body) return { error: "no frame" };

  const style = (el) => {
    const s = getComputedStyle(el);
    return { color: s.color, background: s.backgroundColor };
  };

  // Sample the text nodes a reader would actually look at.
  const samples = [...doc.body.querySelectorAll("h1,h2,h3,p,td,span,a")]
    .filter((el) => el.textContent.trim().length > 3 && el.children.length === 0)
    .slice(0, 10)
    .map((el) => ({ text: el.textContent.trim().slice(0, 28), ...style(el) }));

  return {
    root: style(doc.documentElement),
    body: style(doc.body),
    prefersDark: doc.defaultView.matchMedia("(prefers-color-scheme: dark)").matches,
    forcedColors: doc.defaultView.matchMedia("(forced-colors: active)").matches,
    samples,
  };
});

console.log(JSON.stringify(report, null, 1));
await browser.close();
