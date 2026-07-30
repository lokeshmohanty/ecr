import { chromium } from "playwright";

const [webUrl, serverUrl, token] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: "/run/current-system/sw/bin/google-chrome-stable",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

await page.addInitScript(
  ([url, tok]) => {
    try {
      localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl: url, token: tok }));
    } catch {}
  },
  [serverUrl, token],
);

await page.goto(webUrl, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

const geometry = await page.evaluate(() => {
  const describe = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      tag: el.tagName,
      cls: el.className.toString().slice(0, 70),
      w: Math.round(r.width),
      h: Math.round(r.height),
      display: s.display,
      minHeight: s.minHeight,
      overflowY: s.overflowY,
      children: el.children.length,
    };
  };

  const main = document.querySelector("main");
  const section = main?.querySelector("section");
  const scroller = section?.querySelector(".scroll-y");
  const inner = scroller?.firstElementChild;

  return {
    main: describe(main),
    mainCols: main ? getComputedStyle(main).gridTemplateColumns : null,
    mainRows: main ? getComputedStyle(main).gridTemplateRows : null,
    listCell: describe(main?.children[1]),
    section: describe(section),
    scroller: describe(scroller),
    inner: describe(inner),
    innerHeightStyle: inner?.getAttribute("style"),
  };
});

console.log(JSON.stringify(geometry, null, 2));

await browser.close();
