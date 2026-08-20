/**
 * How long a keystroke takes to reach the screen.
 *
 * Everything else in this repo measures whether the client is *correct*. This
 * measures whether it keeps up, which is a different question and the only one
 * that can answer "holding j feels laggy" — a suite that waits for the client
 * to settle before looking is, by construction, blind to it.
 *
 * What is reported is the gap between the keystroke and the frame that paints
 * its result, at a key-repeat rate, over a mailbox big enough to virtualise.
 * The long-task total beside it is the same cost seen from the other end: work
 * on the main thread that a repeat landing in the middle of would wait behind.
 *
 *   node bench-keys.mjs <url> [key] [presses]
 */
import { chromium } from "playwright";
import { executablePath, keepOffline } from "./browser.mjs";

const [url, key = "j", presses = "120", pageSize = "100", prelude = ""] =
  process.argv.slice(2);
const COUNT = Number(presses);
const PAGE = Number(pageSize);

/** A held key repeats at about this, once the initial delay has passed. */
const REPEAT_MS = 33;

const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await keepOffline(page, url);

await page.addInitScript(
  ([base, size]) => {
    try {
      localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl: base, token: "" }));
      localStorage.setItem(
        "ecr.client",
        JSON.stringify({ preferences: { pageSize: size }, keybindings: [] }),
      );
    } catch {
      /* sandboxed frame */
    }
  },
  [url, PAGE],
);

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[class*='row-grid']", { timeout: 30_000 });
await page.waitForTimeout(2500);

/*
 * The clock lives in the page. Measuring from node adds the CDP round trip to
 * every sample, which is the same order as the thing being measured.
 */
await page.evaluate(() => {
  const state = {
    marks: [],
    frames: [],
    longTasks: 0,
    longTaskMs: 0,
    pending: null,
  };
  window.__bench = state;

  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      state.longTasks += 1;
      state.longTaskMs += entry.duration;
    }
  }).observe({ entryTypes: ["longtask"] });

  /*
   * The handler's own synchronous cost, which is the part the app controls.
   * Keystroke-to-paint cannot see it on a machine that keeps up: the answer
   * there is "the next frame", whatever the work was, so a change that halves
   * the work moves the number not at all. What a slower engine turns into
   * dropped frames is this.
   */
  state.handler = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name !== "keydown") continue;
      state.handler.push(entry.processingEnd - entry.processingStart);
    }
  }).observe({ type: "event", durationThreshold: 0, buffered: false });

  let last = performance.now();
  const tick = (now) => {
    state.frames.push(now - last);
    last = now;
    // The first frame after a keystroke is the one that shows its result.
    if (state.pending !== null) {
      state.marks.push(now - state.pending);
      state.pending = null;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  window.addEventListener(
    "keydown",
    () => {
      if (state.pending === null) state.pending = performance.now();
    },
    true,
  );
});

/*
 * Warm, and then reproduce what a reader actually does.
 *
 * A held key is not a stream of evenly spaced presses. The OS waits out an
 * initial delay — half a second on most setups — before it repeats at all, and
 * `FOLLOW_DELAY` is 140ms, so the reading pane opens a thread *inside that
 * gap* and is still building it when the repeats arrive. Measuring an even
 * stream never produces that, which is the one pattern the complaint is about.
 */
for (let i = 0; i < 10; i += 1) {
  await page.keyboard.press(key);
  await page.waitForTimeout(REPEAT_MS);
}
await page.waitForTimeout(1200);
// One step, then the initial repeat delay, then the repeats.
await page.keyboard.press(key);
await page.waitForTimeout(500);

// Anything the run should be measured *in*, such as `v` for a range being
// drawn — which is the state where every row on screen re-reads the cursor.
for (const stroke of prelude.split(",").filter(Boolean)) {
  await page.keyboard.press(stroke);
  await page.waitForTimeout(REPEAT_MS);
}
await page.evaluate(() => {
  const s = window.__bench;
  s.marks.length = 0;
  s.frames.length = 0;
  s.longTasks = 0;
  s.longTaskMs = 0;
  s.handler.length = 0;
});

const started = Date.now();
for (let i = 0; i < COUNT; i += 1) {
  await page.keyboard.press(key);
  await page.waitForTimeout(REPEAT_MS);
}
const wall = Date.now() - started;

const result = await page.evaluate(() => {
  const s = window.__bench;
  const sorted = [...s.marks].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  const handler = [...s.handler].sort((a, b) => a - b);
  const handlerAt = (q) => handler[Math.min(handler.length - 1, Math.floor(handler.length * q))] ?? 0;
  const frames = [...s.frames].sort((a, b) => a - b);
  const frameAt = (q) => frames[Math.min(frames.length - 1, Math.floor(frames.length * q))] ?? 0;
  return {
    samples: sorted.length,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    worst: sorted[sorted.length - 1] ?? 0,
    frameP50: frameAt(0.5),
    frameP99: frameAt(0.99),
    dropped: frames.filter((f) => f > 32).length,
    handlerN: handler.length,
    handlerP50: handlerAt(0.5),
    handlerP90: handlerAt(0.9),
    handlerP99: handlerAt(0.99),
    handlerTotal: handler.reduce((a, b) => a + b, 0),
    longTasks: s.longTasks,
    longTaskMs: s.longTaskMs,
  };
});

const ms = (n) => `${n.toFixed(1)}ms`;
console.log(`  key ${key} x${COUNT}, page ${PAGE}${prelude ? `, after ${prelude}` : ""} — over ${wall}ms`);
console.log(`  keystroke → paint   p50 ${ms(result.p50)}  p90 ${ms(result.p90)}  p99 ${ms(result.p99)}  worst ${ms(result.worst)}`);
console.log(`  frame interval      p50 ${ms(result.frameP50)}  p99 ${ms(result.frameP99)}  over 32ms: ${result.dropped}/${result.samples}`);
console.log(`  keydown handler     p50 ${ms(result.handlerP50)}  p90 ${ms(result.handlerP90)}  p99 ${ms(result.handlerP99)}  total ${ms(result.handlerTotal)} over ${result.handlerN}`);
console.log(`  long tasks          ${result.longTasks}, ${ms(result.longTaskMs)} total`);

await browser.close();
