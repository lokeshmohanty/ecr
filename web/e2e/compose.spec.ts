import { expect, open, test } from "./fixtures";

/**
 * What a keystroke does while a composer is open.
 *
 * The ordinary keys are safe by construction — the app ignores every key while
 * a text field has focus. **The chords are not**: they are matched before that
 * check, deliberately, so focus can leave an open composer without discarding
 * it. Which of them the app may claim is therefore the whole question, and a
 * unit test cannot answer it: the keymap answers the same either way, and what
 * differs is whether a real textarea ever sees the keystroke.
 */
test.describe("keys while composing", () => {
  const reply = 'textarea[aria-label="reply"]';
  /** The reading pane's own scroll container, which the chords below move. */
  const scroller = "[data-thread-scroll]";

  test.beforeEach(async ({ page, server }) => {
    // Short enough that the thread overflows its pane. A pane that cannot
    // scroll passes every test below whatever the app does with the chord,
    // which is the one way this file could be worse than useless.
    await page.setViewportSize({ width: 1280, height: 420 });
    await open(page, server);

    await page.keyboard.press("Enter");
    await expect(page.locator(scroller)).toBeVisible();

    await page.keyboard.press("r");
    await expect(page.locator(reply)).toBeVisible();
    await page.locator(reply).click();
    await page.keyboard.press("i");
    await page.keyboard.type("hello");
    await expect(page.locator(reply)).toHaveValue(/hello/);

    await expect
      .poll(() =>
        page
          .locator(scroller)
          .evaluate((el) => el.scrollHeight - el.clientHeight),
      )
      .toBeGreaterThan(10);
  });

  /**
   * The bug this file was written for. A vim user in insert mode reaches for
   * `C-u` to rub out the line, and `C-e`/`C-y` are an emacs habit in any text
   * field; all of them were bound globally and matched before the app checks
   * whether a text field has focus, so the message *behind* the composer
   * scrolled instead — while the caret sat in a textarea that never saw the
   * keystroke. It reads as the composer being broken, and nothing on screen
   * connects it to a binding for the pane underneath.
   */
  for (const chord of ["Control+u", "Control+d", "Control+e", "Control+y"]) {
    test(`${chord} does not scroll the pane behind the composer`, async ({ page }) => {
      const at = () => page.locator(scroller).evaluate((el) => el.scrollTop);

      // Parked between the ends, so a scroll in *either* direction is a
      // change. At the top, every chord that scrolls up passes by doing
      // nothing, which is the same answer as the fix and proves neither.
      await page.locator(scroller).evaluate((el) => {
        el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
      });
      const before = await at();
      expect(before).toBeGreaterThan(0);

      await page.keyboard.press(chord);
      await page.waitForTimeout(150);

      expect(await at()).toBe(before);
      await expect(page.locator(reply)).toBeFocused();
    });
  }

  /**
   * The reason the chord branch exists at all, and it has to keep working.
   * Note what "leaving" means here: the *pane* stops being the focused one.
   * The textarea keeps the caret, which is what makes coming back free.
   */
  test("C-h leaves the composer without discarding it", async ({ page }) => {
    const pane = page.locator(`section.pane:has(${reply})`);
    await expect(pane).toHaveClass(/pane-focused/);

    await page.keyboard.press("Control+h");
    await expect(pane).not.toHaveClass(/pane-focused/);

    await page.keyboard.press("Control+l");
    await expect(pane).toHaveClass(/pane-focused/);
    await expect(page.locator(reply)).toHaveValue(/hello/);
  });
});
