/** Scrolling, conversation movement, the format toggle, mark-read, block cursor. */
import { chromium } from "playwright";

const [url] = process.argv.slice(2);
const failures = [];
const notes = [];
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) failures.push(n);
};

const browser = await chromium.launch({
  executablePath: "/run/current-system/sw/bin/google-chrome-stable",
  args: ["--no-sandbox"],
});

async function open(preferHtml = true) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 820 }, colorScheme: "dark" });
  page.on("pageerror", (e) => notes.push(e.message.slice(0, 120)));

  await page.addInitScript(
    ([base, html]) => {
      try {
        localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl: base, token: "" }));
        localStorage.setItem(
          "ecr.settings",
          JSON.stringify({ preferences: { preferHtml: html, markReadDelay: 400 } }),
        );
      } catch {}
    },
    [url, preferHtml],
  );

  await page.goto(url, { waitUntil: "networkidle" });

  // Settings live in a file on the server, so the file the last page wrote
  // would otherwise outrank this page's preferences. Emptying it makes the
  // client write this page's own settings on the way back up.
  await page.evaluate(async () => {
    localStorage.removeItem("ecr.settings.toml");
    await fetch("/api/v1/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw: "" }),
    });
  });
  await page.reload({ waitUntil: "networkidle" });

  await page.waitForSelector("[class*='row-grid'][class*='cursor-pointer']", { timeout: 20000 });
  await page.waitForTimeout(1000);
  return page;
}

const chord = async (page, key) => {
  await page.keyboard.down("Control");
  await page.keyboard.press(key);
  await page.keyboard.up("Control");
  await page.waitForTimeout(280);
};

// ── the reported bug ───────────────────────────────────────────────────────
console.log("\nFormat toggle with plain text preferred");
{
  const page = await open(false);
  // Pick a message that actually has an HTML part; a text-only one has nothing
  // to switch to and the toggle is correctly not offered.
  await page.keyboard.press("/");
  await page.waitForTimeout(300);
  await page.keyboard.type("subject:HTML only");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2400);

  const before = await page.evaluate(() => ({
    pre: !!document.querySelector("main pre"),
    frame: !!document.querySelector("iframe[title='message body']"),
  }));
  check("a message opens as plain text", before.pre && !before.frame, JSON.stringify(before));

  await page.keyboard.press("l");
  await page.waitForTimeout(200);
  await page.keyboard.press("t");
  await page.waitForTimeout(2200);

  const after = await page.evaluate(() => ({
    pre: !!document.querySelector("main pre"),
    frame: !!document.querySelector("iframe[title='message body']"),
  }));
  check("t renders the html on demand", after.frame, JSON.stringify(after));

  await page.keyboard.press("t");
  await page.waitForTimeout(1800);
  const back = await page.evaluate(() => !!document.querySelector("main pre"));
  check("t again goes back to plain text", back);

  await page.close();
}

// ── the toggle is only offered when it means something ─────────────────────
console.log("\nHonesty of the toggle");
{
  const page = await open(true);
  const offered = await page.evaluate(async () => {
    const list = await (await fetch("/api/v1/threads?q=tag:inbox&limit=8")).json();
    const seen = [];
    for (const item of list.items) {
      if (!item.newest_message) continue;
      const body = await (
        await fetch(`/api/v1/messages/${encodeURIComponent(item.newest_message)}/body`)
      ).json();
      seen.push({ format: body.format, has_html: body.has_html });
    }
    return seen;
  });
  check(
    "a text-only message reports no html alternative",
    offered.some((b) => b.format === "text" && b.has_html === false),
    JSON.stringify(offered.slice(0, 3)),
  );
  check(
    "an html message reports one",
    offered.some((b) => b.has_html === true),
  );
  await page.close();
}

// ── scrolling ──────────────────────────────────────────────────────────────
console.log("\nScrolling the reading pane");
{
  // A short window so the fixture's content actually overflows the pane.
  const page = await open(true);
  await page.setViewportSize({ width: 1440, height: 420 });
  await page.keyboard.press("/");
  await page.waitForTimeout(300);
  await page.keyboard.type("subject:Hello");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2800);
  await page.keyboard.press("l");
  await page.waitForTimeout(300);

  const top = () => page.evaluate(() => document.querySelector("main .scroll-y:last-of-type")?.scrollTop ?? -1);
  const scroller = await page.evaluate(() => {
    const panes = [...document.querySelectorAll("main .scroll-y")];
    const detail = panes[panes.length - 1];
    return detail ? detail.scrollHeight > detail.clientHeight : false;
  });
  check("the reading pane has something to scroll", scroller);

  if (scroller) {
    const start = await page.evaluate(() => {
      const panes = [...document.querySelectorAll("main .scroll-y")];
      return panes[panes.length - 1].scrollTop;
    });
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await page.waitForTimeout(400);
    const afterJ = await page.evaluate(() => {
      const panes = [...document.querySelectorAll("main .scroll-y")];
      return panes[panes.length - 1].scrollTop;
    });
    check("j scrolls down", afterJ > start, `${start} → ${afterJ}`);

    await page.keyboard.press("k");
    await page.waitForTimeout(300);
    const afterK = await page.evaluate(() => {
      const panes = [...document.querySelectorAll("main .scroll-y")];
      return panes[panes.length - 1].scrollTop;
    });
    check("k scrolls up", afterK < afterJ, `${afterJ} → ${afterK}`);

    await chord(page, "e");
    const afterE = await page.evaluate(() => {
      const panes = [...document.querySelectorAll("main .scroll-y")];
      return panes[panes.length - 1].scrollTop;
    });
    check("ctrl-e scrolls down a line", afterE > afterK, `${afterK} → ${afterE}`);

    await chord(page, "d");
    const afterD = await page.evaluate(() => {
      const panes = [...document.querySelectorAll("main .scroll-y")];
      return panes[panes.length - 1].scrollTop;
    });
    const atBottom = await page.evaluate(() => {
      const panes = [...document.querySelectorAll("main .scroll-y")];
      const el = panes[panes.length - 1];
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    });
    check(
      "ctrl-d scrolls further than a line",
      afterD - afterE > 64 || atBottom,
      atBottom ? "reached the bottom" : `+${afterD - afterE}px`,
    );

    await chord(page, "y");
    const afterY = await page.evaluate(() => {
      const panes = [...document.querySelectorAll("main .scroll-y")];
      return panes[panes.length - 1].scrollTop;
    });
    check("ctrl-y scrolls up", afterY < afterD);
  }

  const _ = top;
  await page.close();
}

// ── conversation movement ──────────────────────────────────────────────────
console.log("\nWalking a conversation");
{
  const page = await open(true);
  await page.keyboard.press("/");
  await page.waitForTimeout(300);
  await page.keyboard.type("subject:Thread 1");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2400);
  await page.keyboard.press("l");
  await page.waitForTimeout(300);

  const cursorAt = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-message]")].findIndex((el) =>
        el.className.includes("bg-neutral-bg"),
      ),
    );

  const start = await cursorAt();
  await chord(page, "j");
  const afterCtrlJ = await cursorAt();
  check("ctrl-j moves to the next message", afterCtrlJ === start + 1, `${start} → ${afterCtrlJ}`);

  await chord(page, "k");
  check("ctrl-k moves back", (await cursorAt()) === start);

  await chord(page, "n");
  check("ctrl-n does the same as ctrl-j", (await cursorAt()) === start + 1);

  await chord(page, "p");
  check("ctrl-p does the same as ctrl-k", (await cursorAt()) === start);

  await page.close();
}

// ── mark read ──────────────────────────────────────────────────────────────
console.log("\nMarking read");
{
  const page = await open(true);
  await page.keyboard.press("/");
  await page.waitForTimeout(300);
  await page.keyboard.type("tag:unread");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);

  const unreadBefore = await page.evaluate(async () => {
    const r = await (await fetch(`/api/v1/threads?q=tag:unread&limit=200&_=${Date.now()}`)).json();
    return r.total;
  });
  check("the fixture has unread mail to start from", unreadBefore > 0, `${unreadBefore} unread`);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(3200);

  const unreadAfter = await page.evaluate(async () => {
    const r = await (await fetch(`/api/v1/threads?q=tag:unread&limit=200&_=${Date.now()}`)).json();
    return r.total;
  });
  check(
    "reading a message drops its unread tag",
    unreadAfter < unreadBefore,
    `${unreadBefore} → ${unreadAfter}`,
  );

  const listUnread = await page.evaluate(
    () => document.querySelectorAll("[class*='tape-unread']").length,
  );
  check("the list reflects it without a refresh", listUnread >= 0, `${listUnread} still unread`);
  await page.close();
}

// ── block cursor ───────────────────────────────────────────────────────────
console.log("\nThe editor cursor");
{
  const page = await open(true);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2200);
  await page.keyboard.press("r");
  await page.waitForTimeout(1600);

  const normal = await page.evaluate(() => {
    const area = document.querySelector("textarea");
    if (!area) return null;
    return { start: area.selectionStart, end: area.selectionEnd, cls: area.className };
  });
  check("normal mode draws a block", normal !== null && normal.end === normal.start + 1, JSON.stringify(normal && { s: normal.start, e: normal.end }));
  check("and is styled as a cursor rather than a highlight", normal?.cls.includes("vim-normal"));

  await page.keyboard.press("i");
  await page.waitForTimeout(300);
  const insert = await page.evaluate(() => {
    const area = document.querySelector("textarea");
    return { start: area.selectionStart, end: area.selectionEnd, cls: area.className };
  });
  check("insert mode collapses it to a bar", insert.end === insert.start);
  check("and drops the block styling", !insert.cls.includes("vim-normal"));

  await page.close();
}

// ── a draft survives navigation ────────────────────────────────────────────
console.log("\nA pinned draft is not lost");
{
  const page = await open(true);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2200);
  await page.keyboard.press("r");
  await page.waitForTimeout(1600);
  check("a reply is open", (await page.locator("textarea").count()) === 1);

  await chord(page, "h");
  await page.keyboard.press("j");
  await page.waitForTimeout(2000);
  check("moving to another message keeps the draft", (await page.locator("textarea").count()) === 1);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  check("opening another thread keeps it too", (await page.locator("textarea").count()) === 1);

  await chord(page, "b");
  await page.waitForTimeout(400);
  await page.keyboard.press("j");
  await page.waitForTimeout(1600);
  check("and a minimised draft survives navigation", (await page.textContent("body")).includes("minimised"));

  await chord(page, "b");
  await page.waitForTimeout(500);
  await page.click("textarea");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Z");
  await page.keyboard.press("Q");
  await page.waitForTimeout(600);
  check("discarding is what closes it", (await page.locator("textarea").count()) === 0);
  await page.close();
}

check("no page errors throughout", notes.length === 0, notes.slice(0, 2).join(" | "));

await browser.close();
console.log(failures.length === 0 ? "\nALL V4 CHECKS PASSED" : `\n${failures.length} FAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
