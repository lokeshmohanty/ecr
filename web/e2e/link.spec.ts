import type { Page } from "@playwright/test";
import { expect, open, test } from "./fixtures";

/**
 * `html_only.eml`: the one message whose whole body is HTML carrying a plain
 * `<a href>`. It is the only fixture with a link not inside a
 * `multipart/related` message, and it is what both halves of this spec need.
 */
const LINKED = "id:mime3@example.com";

/** The frame the message HTML renders in, once the thread is open. */
const frame = (page: Page) =>
	page.locator('iframe[title="message body"]').contentFrame();

/** Opens the one thread the query matches, by its subject. */
const openOnly = async (page: Page, query: string) => {
	await page.keyboard.press("/");
	await page.keyboard.type(query);
	await page.keyboard.press("Enter");
	await expect(page.getByRole("heading", { name: "HTML only" })).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(frame(page).getByText("Paragraph one.")).toBeVisible();
};

test.describe("clicking a link in a message", () => {
	test.beforeEach(async ({ page, server }) => {
		await open(page, server);
	});

	test("opens it from the HTML frame", async ({ page }) => {
		await openOnly(page, LINKED);

		// Chromium delivers a click to a listener the parent put on the frame,
		// so the link is *not* rewritten to the `about:blank` sentinel WebKit
		// needs — the half this suite can see, and the reason the fix keeps
		// both paths rather than the one the engine under test never takes.
		// (WebKitGTK is verified out of band; see the harness note in
		// `BodyFrame`.)
		await expect(frame(page).getByRole("link", { name: "a link" })).toHaveAttribute(
			"href",
			"https://example.com/link",
		);

		const [popup] = await Promise.all([
			page.waitForEvent("popup", { timeout: 3000 }).catch(() => null),
			frame(page).getByRole("link", { name: "a link" }).click(),
		]);
		expect(popup?.url()).toContain("example.com/link");

		// The message survives the click: nothing navigated the frame away.
		await expect(frame(page).getByText("Paragraph one.")).toBeVisible();
	});

	test("opens it from the plain text pane", async ({ page }) => {
		await openOnly(page, LINKED);

		// The fixture's default is HTML, so read it as text first — the pane
		// the `pre` renders the converted markdown in, where the same link
		// is an `<a>` in the app's own document.
		await page.keyboard.press("l");
		await page.getByRole("button", { name: /as plain text/ }).click();
		const body = page.locator("main pre");
		await expect(body).toBeVisible();

		const [popup] = await Promise.all([
			page.waitForEvent("popup", { timeout: 3000 }).catch(() => null),
			body.getByRole("link", { name: "a link" }).click(),
		]);
		expect(popup?.url()).toContain("example.com/link");
	});
});
