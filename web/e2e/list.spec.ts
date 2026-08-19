import { configure, expect, open, test, ROW } from "./fixtures";

/** The fixtures are all dated 01 Apr 2026, which is 05:30 later in Kolkata. */
const dateCell = (page: import("@playwright/test").Page) =>
  page.locator(`${ROW} [data-date]`).first();

const heading = (page: import("@playwright/test").Page) =>
  page.locator("[data-heading]").first();

test.describe("the list's date column", () => {
  /**
   * A row says what the heading above it does not. The fixtures are months old
   * and inside the pinned clock's year, so they group under a month — and
   * printing `01 Apr 19:30` under a heading that reads APRIL says the month
   * twice and spends seven characters of a column the subject wants.
   */
  test("says what the heading above it does not", async ({ page, server }) => {
    await open(page, server);

    await expect(heading(page)).toHaveText("April");
    await expect(dateCell(page)).toHaveText(/^Wed 01$/);
  });

  test("renders in the configured zone, not the machine's", async ({
    page,
    server,
  }) => {
    // 14:00 UTC on 01 April is 04:00 on the *second* at +14, so the weekday and
    // the day both move — the whole reason boundaries are computed in the
    // display zone rather than the machine's.
    await configure(server, '[reading]\ntimezone = "Pacific/Kiritimati"\n');

    await open(page, server);
    await expect(dateCell(page)).toHaveText(/^Thu 02$/);
  });

  /** An explicit format is a choice, and a heading does not get to narrow it. */
  test("a chosen format is printed in full under a heading", async ({
    page,
    server,
  }) => {
    await configure(server, '[reading]\ntimezone = "UTC"\nlist_date_format = "datetime"\n');

    await open(page, server);
    await expect(dateCell(page)).toHaveText(/^01 Apr 14:00$/);
  });

  test("the iso format is the same width for every row", async ({ page, server }) => {
    await configure(server, '[reading]\nlist_date_format = "iso"\n');

    await open(page, server);
    await expect(dateCell(page)).toHaveText(/^2026-04-01$/);
  });

  test("a bad timezone is reported with its line rather than silently ignored", async ({
    page,
    server,
  }) => {
    await configure(server, '[reading]\ntimezone = "Mars/Olympus"\n');

    await open(page, server);

    // Surfaced to the reader, with the line to go and fix — not swallowed into
    // the machine's own zone, which would look plausible and be wrong.
    await expect(page.getByText(/does not name a timezone/)).toBeVisible();
    await expect(page.getByText(/line \d+/)).toBeVisible();
  });

  test("the date never collides with the subject, at any width", async ({ page, server }) => {
    await open(page, server);

    for (const width of [360, 700, 1100, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);

      const overlap = await page.evaluate((rowSelector) => {
        const row = document.querySelector(rowSelector);
        if (!row) return "no row";
        const cells = [...row.children] as HTMLElement[];
        const subject = cells.at(-2)?.getBoundingClientRect();
        const date = cells.at(-1)?.getBoundingClientRect();
        if (!subject || !date) return "no cells";
        return subject.right > date.left + 1 ? `overlap by ${subject.right - date.left}px` : "";
      }, ROW);

      expect(overlap, `at ${width}px`).toBe("");
    }
  });
});
