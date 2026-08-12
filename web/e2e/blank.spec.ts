import { expect, open, test, ROW } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Holds every thread request open for this long.
 *
 * Without it this would be racing the server rather than asserting a property:
 * the fixture maildir answers in a few milliseconds, so the wrong subject would
 * usually be on screen for less than a frame and the test would pass whatever
 * the client did. Slowing the request is what turns "it happened to look fine"
 * into "it cannot look otherwise". Against the real 45k mailbox this window is
 * about seven hundred milliseconds on a cold body, so the delay is realistic
 * rather than adversarial.
 */
const HELD = 500;

/**
 * Every distinct subject the pane showed, in order, for as long as an action
 * takes.
 *
 * Sampled per animation frame from inside the page: polling from node cannot
 * see a state that lasts one request, and the question — what did the reader
 * have in front of them — is only meaningful at the rate their eye works.
 */
async function watchSubjects(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __seen?: string[]; __stop?: number };
    w.__seen = [];
    const tick = () => {
      const text = document.querySelector("h1")?.textContent ?? "(none)";
      if (w.__seen![w.__seen!.length - 1] !== text) w.__seen!.push(text);
      w.__stop = requestAnimationFrame(tick);
    };
    tick();
  });
}

async function subjectsSeen(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __seen: string[]; __stop: number };
    cancelAnimationFrame(w.__stop);
    return w.__seen;
  });
}

test.describe("the reading pane never shows the wrong thread", () => {
  /**
   * The end state, not the window: that a switch settles on the new thread and
   * neither snaps back to the previous one nor passes through an empty pane.
   * The *timing* — that the old subject is gone before the network could have
   * answered — is the test below, and that is the one that fails without the
   * fix. This one guards the outcome the fix must not cost.
   */
  test("a switch settles on the new thread, with nothing empty on the way", async ({
    page,
    server,
  }) => {
    await open(page, server);
    await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });
    const before = await page.locator("h1").innerText();

    await page.route("**/api/v1/threads/*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, HELD));
      await route.continue();
    });

    await watchSubjects(page);
    await page.locator(ROW).nth(2).click();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(HELD * 2);
    const seen = await subjectsSeen(page);

    const after = await page.locator("h1").innerText();
    expect(after, "the click did not open a different thread").not.toBe(before);

    // The old subject may be the first sample, because the watcher starts
    // before the click. What it must never be is still there afterwards.
    const afterTheSwitch = seen.slice(seen.indexOf(before) + 1);
    expect(
      afterTheSwitch,
      `the pane went back to the previous thread: ${JSON.stringify(seen)}`,
    ).not.toContain(before);

    // And it went straight there: no empty state in between.
    expect(seen, `an empty pane was shown: ${JSON.stringify(seen)}`).not.toContain(
      "(none)",
    );
  });

  /**
   * The header is drawn from the list's own summary, so it owes nothing to the
   * network. With every thread request held for half a second, the subject must
   * still be up long before the request could possibly have answered.
   */
  test("the subject is up before the thread could have arrived", async ({
    page,
    server,
  }) => {
    await open(page, server);
    await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });

    await page.route("**/api/v1/threads/*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, HELD));
      await route.continue();
    });

    const before = await page.locator("h1").innerText();

    const started = Date.now();
    await page.locator(ROW).nth(3).click();
    await page.keyboard.press("Enter");

    // Not "shows the right subject" — that is test one's job — but "stopped
    // showing the old one", which is the half that cannot be had from the
    // network in the time allowed.
    await expect(page.locator("h1")).not.toHaveText(before, {
      timeout: HELD - 150,
    });
    expect(Date.now() - started).toBeLessThan(HELD);
  });
});
