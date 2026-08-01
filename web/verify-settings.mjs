/** The settings file: edited in the browser, written on the server, read back. */
import { chromium } from "playwright";
import { executablePath } from "./browser.mjs";

const [url] = process.argv.slice(2);
const failures = [];
const notes = [];
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) failures.push(n);
};

const browser = await chromium.launch({
  executablePath,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
page.on("pageerror", (e) => notes.push(e.message.slice(0, 140)));

await page.addInitScript((base) => {
  try {
    localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl: base, token: "" }));
  } catch {
    /* sandboxed frame */
  }
}, url);

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector("[class*='row-grid'][class*='cursor-pointer']", { timeout: 20000 });
await page.waitForTimeout(1200);

const raw = () => page.evaluate(async () => (await (await fetch("/api/v1/config")).json()).raw);

console.log("\nThe file the server holds");
{
  const text = await raw();
  check("a first run writes the file", text.length > 0, `${text.length} bytes`);
  check("it is commented", (text.match(/^#/gm) ?? []).length > 40);
  check("it explains every default", (text.match(/^# default:/gm) ?? []).length >= 11);
  check("the everyday options come first", text.indexOf("[reading]") < text.indexOf("ADVANCED"));
  check("keybindings are in it", text.includes("[keybindings.detail]"));
  check("packages are in it", text.includes("[packages.mbsync]"));
}

console.log("\nEditing it");
await page.keyboard.press(",");
await page.waitForTimeout(800);
check("the settings pane opens", (await page.textContent("body")).includes("Settings"));

await page.click("text=Preferences & keys");
await page.waitForTimeout(500);
const editor = page.locator("textarea").first();
check("the editor shows the file itself", (await editor.inputValue()).includes("[reading]"));

// A comment the generator would never produce: it proves the file is edited
// rather than regenerated.
await editor.click();
await page.keyboard.press("Escape");
await page.keyboard.press("g");
await page.keyboard.press("g");
await page.keyboard.press("O");
await page.keyboard.type("# a note of my own");
await page.keyboard.press("Escape");
await page.keyboard.press("Z");
await page.keyboard.press("Z");
await page.waitForTimeout(1200);

{
  const text = await raw();
  check("the edit reached the server", text.includes("# a note of my own"));
}

console.log("\nA toggle must not eat the comment");
await page.keyboard.press(",");
await page.waitForTimeout(700);
const toggle = page.locator("button", { hasText: "managed by ecr" }).first();
await toggle.click();
await page.waitForTimeout(1200);
check("the switch moves in the UI", (await toggle.getAttribute("class")).includes("bg-obligation"));
{
  const text = await raw();
  check("the comment survived the toggle", text.includes("# a note of my own"));
  const section = text.slice(text.indexOf("[packages.notmuch]")).split("\n").slice(0, 4).join(" | ");
  check(
    "and the toggle took effect",
    /\[packages\.notmuch\][^[]*management = "ecr"/s.test(text),
    section,
  );
}

console.log("\nA file that will not parse");
await page.click("text=Preferences & keys");
await page.waitForTimeout(400);
const bad = page.locator("textarea").first();
await bad.click();
await page.keyboard.press("Escape");
await page.keyboard.press("g");
await page.keyboard.press("g");
await page.keyboard.press("O");
await page.keyboard.type("prefer_html = = true");
await page.keyboard.press("Escape");
await page.keyboard.press("Z");
await page.keyboard.press("Z");
await page.waitForTimeout(900);

{
  const body = await page.textContent("body");
  check("it is reported with a line number", /line \d+:/.test(body), body.match(/line \d+:[^<]{0,60}/)?.[0] ?? "");
  check("the editor stays open so it can be fixed", (await page.locator("textarea").count()) > 0);
  const text = await raw();
  check("and the good file on disk is untouched", !text.includes("= = true"));
}

console.log("\nA preference actually applies");
{
  const applied = await page.evaluate(async () => {
    const current = (await (await fetch("/api/v1/config")).json()).raw;
    const next = current.replace("prefer_html = true", "prefer_html = false");
    await fetch("/api/v1/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw: next }),
    });
    return next.includes("prefer_html = false");
  });
  check("the file can be written by hand too", applied);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("[class*='row-grid'][class*='cursor-pointer']", { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);

  const plain = await page.evaluate(() => !!document.querySelector("main pre"));
  check("and the client obeys it after a reload", plain);
}

check("no page errors throughout", notes.length === 0, notes.slice(0, 2).join(" | "));

await browser.close();
console.log(failures.length === 0 ? "\nALL SETTINGS CHECKS PASSED" : `\n${failures.length} FAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
