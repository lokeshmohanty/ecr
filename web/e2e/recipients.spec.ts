import type { Page } from "@playwright/test";
import { expect, open, test } from "./fixtures";

/**
 * The fixture addresses are short — `alice@example.com` — and fit the pane at
 * every width the client is used at, so a recipient line never actually
 * overflows. The feature is only about what happens when one does, so these
 * tests arrange that: a `max-width` on the value cell clips the line exactly as
 * a `To:` with thirty addresses would, and everything after is the client's own
 * behaviour — the same measurement, the same button.
 */
const squeeze = (page: Page) =>
	page.addStyleTag({ content: "[data-recipients] { max-width: 64px; }" });

/** Opens thread 1, whose newest message (`msg2`) is the one shown open. */
const openThread1 = async (page: Page) => {
	await page.keyboard.press("/");
	await page.keyboard.type("id:msg1@example.com");
	await page.keyboard.press("Enter");
	await page.keyboard.press("Enter");
	await expect(page.locator("[data-recipients='to']")).toBeVisible();
};

test.describe("a recipient line", () => {
	test.beforeEach(async ({ page, server }) => {
		await open(page, server);
		await openThread1(page);
	});

	test("is plain text while it fits", async ({ page }) => {
		const cell = page.locator("[data-recipients='to']");
		await expect(cell).toContainText("alice@example.com");
		// A control that would do nothing is not offered.
		await expect(cell.locator("button")).toHaveCount(0);
	});

	test("opens and folds once it is cut off", async ({ page }) => {
		await squeeze(page);

		const toggle = page.locator("[data-recipients='to'] button");
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAttribute("aria-expanded", "false");

		// Folded: the address is longer than the cell can hold.
		const folded = await toggle.evaluate((el) => el.scrollWidth - el.clientWidth);
		expect(folded).toBeGreaterThan(0);

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		// Open: it wraps, so nothing is hidden any more.
		const opened = await toggle.evaluate((el) => el.scrollWidth - el.clientWidth);
		expect(opened).toBeLessThanOrEqual(1);

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
	});
});
