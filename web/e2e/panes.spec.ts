import { configure, expect, open, test } from "./fixtures";

/**
 * The three panes are a desktop's answer, not every window's. Between a phone
 * and `sidebar_min_width` the client shows two — the list and the thread — with
 * the sidebar laid over the list while it has focus.
 *
 * A viewport is set before `goto`, because the width the layout reads is
 * sampled as the client boots and updated on resize; loading wide and then
 * narrowing would test the resize path rather than the layout.
 */
const sidebar = "nav:has([data-row])";
const views = '[aria-label="Views"], [aria-label="Close views"]';

test.describe("panes", () => {
  test("a narrow window folds the sidebar into a drawer", async ({ page, server }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await open(page, server);

    await expect(page.locator(sidebar)).toBeHidden();
    // The two that remain, which is the point of the width: the list and the
    // thread beside it rather than three cramped columns.
    await expect(page.locator("#ecr-query")).toBeVisible();
    await expect(page.locator(views)).toBeVisible();

    await page.locator(views).click();
    await expect(page.locator(sidebar)).toBeVisible();
  });

  test("picking a view in the drawer closes it again", async ({ page, server }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await open(page, server);

    await page.locator(views).click();
    await page.locator('nav [data-row]:has-text("All Mail")').first().click();

    await expect(page.locator(sidebar)).toBeHidden();
    await expect(page.locator("#ecr-query")).toHaveValue(/\*|tag:/);
  });

  test("a wide window keeps all three panes and offers no drawer", async ({
    page,
    server,
  }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await open(page, server);

    await expect(page.locator(sidebar)).toBeVisible();
    await expect(page.locator(views)).toBeHidden();
  });

  /**
   * The width is a setting rather than a breakpoint, so this is the assertion
   * that it is actually read: the same 900px window that folds the sidebar
   * above keeps it when the device asks for a lower line.
   */
  test("the width the sidebar needs is configurable", async ({ page, server }) => {
    await configure(server, "[sidebar]\nsidebar_min_width = 800\n");

    await page.setViewportSize({ width: 900, height: 800 });
    await open(page, server);

    await expect(page.locator(sidebar)).toBeVisible();
    await expect(page.locator(views)).toBeHidden();
  });
});
