import type { Page } from "@playwright/test";
import { expect, open, test, ROW } from "./fixtures";

/**
 * The scroll chords are global: `C-e` means *move this view* in whichever pane
 * has focus, and the cursor stays where the reader put it. A short window is
 * what makes any of it observable — at a desktop height the fixture's list and
 * sidebar both fit, `scrollTop` never leaves zero, and a test of scrolling
 * passes whatever the client does.
 */
const listScroll = "[data-list-scroll]";
const sidebarScroll = "[data-sidebar-scroll]";
const threadScroll = "[data-thread-scroll]";

/** The row pitch the virtual scroller counts in: the card plus its gap. */
const ROW_HEIGHT = 82;

const scrollTop = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => el.scrollTop);

/**
 * A keystroke pressed before the pane has anything to scroll is a keystroke
 * that lands and does nothing, and the assertion afterwards then fails at the
 * poll's timeout with no hint that it was a race. `open` waits for the first
 * row, which is earlier than the list being taller than its own viewport.
 */
async function overflowing(page: Page, selector: string): Promise<void> {
  await expect
    .poll(() =>
      page
        .locator(selector)
        .evaluate((el) => el.scrollHeight - el.clientHeight),
    )
    .toBeGreaterThan(0);
}

test.describe("keyboard scrolling", () => {
  test("ctrl-e and ctrl-y move the list a row at a time", async ({ page, server }) => {
    await page.setViewportSize({ width: 1400, height: 400 });
    await open(page, server);
    await overflowing(page, listScroll);

    const cursor = page.locator(".row-card-selected");
    const before = await cursor.textContent();
    expect(await scrollTop(page, listScroll)).toBe(0);

    await page.keyboard.press("Control+e");
    await expect.poll(() => scrollTop(page, listScroll)).toBe(ROW_HEIGHT);

    // The view moved and the cursor did not: scrolling is not choosing.
    await expect(cursor).toHaveText(before ?? "");

    // And it stays there. Keeping the cursor in view used to run again on
    // every refetch, so the autorefresh poll undid a reader's own scrolling
    // about half a second after they did it. Long enough to cover that.
    await page.waitForTimeout(1500);
    expect(await scrollTop(page, listScroll)).toBe(ROW_HEIGHT);

    await page.keyboard.press("Control+y");
    await expect.poll(() => scrollTop(page, listScroll)).toBe(0);
  });

  test("ctrl-d takes half of the pane it is pressed in", async ({ page, server }) => {
    await page.setViewportSize({ width: 1400, height: 400 });
    await open(page, server);
    await overflowing(page, listScroll);

    // Rounded, because half of an odd viewport is a fraction and Chromium
    // lands on the pixel either side of it.
    const expected = await page
      .locator(listScroll)
      .evaluate((el) =>
        Math.round(
          Math.min(el.clientHeight / 2, el.scrollHeight - el.clientHeight),
        ),
      );

    await page.keyboard.press("Control+d");
    await expect
      .poll(async () => Math.round(await scrollTop(page, listScroll)))
      .toBe(expected);

    // Back to the top, give or take the half-pixel that half of an odd
    // viewport leaves behind.
    await page.keyboard.press("Control+u");
    await expect.poll(() => scrollTop(page, listScroll)).toBeLessThanOrEqual(1);
  });

  test("the sidebar scrolls by one of its own rows, not the list's", async ({
    page,
    server,
  }) => {
    await page.setViewportSize({ width: 1400, height: 400 });
    await open(page, server);
    await overflowing(page, sidebarScroll);

    // `h` is how a keyboard reaches the sidebar; the chord follows focus.
    await page.keyboard.press("h");
    await expect(page.locator("nav.pane-focused")).toBeVisible();

    const row = await page
      .locator("nav [data-row]")
      .first()
      .evaluate((el) => (el as HTMLElement).offsetHeight);
    // A sidebar row is nothing like a thread card, which is the whole reason
    // the step is the pane's own rather than one number for all three.
    expect(row).toBeGreaterThan(0);
    expect(row).toBeLessThan(ROW_HEIGHT);

    await page.keyboard.press("Control+e");
    await expect.poll(() => scrollTop(page, sidebarScroll)).toBe(row);

    // The list stayed still while the sidebar had focus.
    expect(await scrollTop(page, listScroll)).toBe(0);

    await page.keyboard.press("Control+y");
    await expect.poll(() => scrollTop(page, sidebarScroll)).toBe(0);
  });

  /**
   * A short window rather than an expanded thread: `zR` cannot be typed by a
   * keyboard here, because pressing Shift is itself a keydown and an unbound
   * key abandons the pending `z` — leaving `R`, which is reply-all, and a
   * composer over the pane under test.
   */
  test("the thread pane still scrolls with the same chords", async ({ page, server }) => {
    await page.setViewportSize({ width: 1400, height: 300 });
    await open(page, server);

    await page.locator(ROW).first().click();
    await page.waitForSelector(threadScroll);
    await page.keyboard.press("l");
    await overflowing(page, threadScroll);

    // A message has no rows, so its line is the store's own step — clamped by
    // however much of this fixture's thread is off the bottom.
    const expected = await page
      .locator(threadScroll)
      .evaluate((el) => Math.min(64, el.scrollHeight - el.clientHeight));

    await page.keyboard.press("Control+e");
    await expect.poll(() => scrollTop(page, threadScroll)).toBe(expected);

    await page.keyboard.press("Control+y");
    await expect.poll(() => scrollTop(page, threadScroll)).toBe(0);
  });
});
