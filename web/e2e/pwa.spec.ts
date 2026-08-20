import { expect, open, test } from "./fixtures";

/**
 * The manifest is the whole of what makes the browser client installable, and
 * every part of it is a path or a promise that can go stale without anything
 * failing: an icon that 404s, a `start_url` outside the scope, a service
 * worker that was never copied into the bundle. None of that shows up in the
 * app — it shows up as *no install button*, months later, with nothing to
 * point at.
 */
test.describe("the installable client", () => {
	test("serves a manifest the document points at", async ({ page, server }) => {
		await open(page, server);

		const href = await page
			.locator('link[rel="manifest"]')
			.getAttribute("href");
		expect(href).toBe("/manifest.webmanifest");

		const manifest = await server.api<Record<string, unknown>>(
			"/manifest.webmanifest",
		);
		expect(manifest.name).toBe("ecr");
		expect(manifest.display).toBe("standalone");
		// Chromium refuses to install an app whose start_url is outside its scope.
		expect(String(manifest.start_url)).toContain(String(manifest.scope));
	});

	/** An icon that 404s is an app the browser declines to install. */
	test("every icon it names is really there", async ({ page, server }) => {
		await open(page, server);

		const manifest = await server.api<{
			icons: { src: string; sizes: string; purpose: string }[];
		}>("/manifest.webmanifest");

		expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
		for (const icon of manifest.icons) {
			const response = await page.request.get(`${server.url}${icon.src}`);
			expect(response.status(), icon.src).toBe(200);
			expect(response.headers()["content-type"], icon.src).toContain("image/png");
		}

		// Both purposes, or the icon is either cropped inside a circle or drawn
		// as a squircle inside one.
		const purposes = manifest.icons.map((icon) => icon.purpose);
		expect(purposes).toContain("any");
		expect(purposes).toContain("maskable");
	});

	/**
	 * `web/public` is copied into the bundle verbatim by vite, and was missing
	 * from the Nix fileset — so the released artifact shipped a `/sw.js` that
	 * 404ed and an offline boot that had never once worked.
	 */
	test("the service worker is in the bundle", async ({ page, server }) => {
		const response = await page.request.get(`${server.url}/sw.js`);
		expect(response.status()).toBe(200);
		expect(await response.text()).toContain("addEventListener");
	});

	/**
	 * The manifest registers `mailto:` as `/?mailto=%s`, so an installed app is
	 * *navigated to* rather than handed the URL by a shell. The parameter is
	 * stripped once read, or a reload reopens a draft already dismissed.
	 */
	test("a mailto in the query opens a composer, once", async ({
		page,
		server,
	}) => {
		await page.goto(
			`${server.url}/?mailto=${encodeURIComponent("mailto:someone@example.com?subject=Hello")}`,
			{ waitUntil: "networkidle" },
		);

		const to = page.locator('textarea[aria-label="to field"]');
		const subject = page.locator('textarea[aria-label="subject field"]');

		await expect(to).toHaveValue("someone@example.com");
		await expect(subject).toHaveValue("Hello");
		await expect(page).toHaveURL((url) => !url.search.includes("mailto"));

		await page.reload({ waitUntil: "networkidle" });
		await expect(to).toHaveCount(0);
	});
});
