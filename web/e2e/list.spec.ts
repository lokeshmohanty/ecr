import { configure, expect, open, test, ROW } from "./fixtures";

/** The fixtures are all dated 01 Apr 2026, which is 05:30 later in Kolkata. */
const dateCell = (page: import("@playwright/test").Page) =>
  page.locator(`${ROW} .mono`).first();

test.describe("the list's date column", () => {
  test("shows day, month and time for mail from earlier this year", async ({
    page,
    server,
  }) => {
    await open(page, server);
    await expect(dateCell(page)).toHaveText(/^01 Apr \d{2}:\d{2}/);
  });

  test("renders the time in the configured zone, not the machine's", async ({
    page,
    server,
  }) => {
    await configure(server, '[reading]\ntimezone = "UTC"\n');

    await open(page, server);
    // 14:00 UTC is 19:30 in Kolkata; under UTC it must read 14:00.
    await expect(dateCell(page)).toHaveText(/^01 Apr 14:00/);
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
