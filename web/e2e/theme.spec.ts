import { expect, open, test } from "./fixtures";

/** What Tailwind's utilities actually read. */
const paperOf = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--color-paper").trim(),
  );

test.describe("themes", () => {
  test("the server seeds every shipped preset on first listing", async ({ server }) => {
    const listing = await server.api<{ presets: { path: string; builtin: boolean }[] }>(
      "/api/v1/themes",
    );

    expect(listing.presets.length).toBe(10);
    expect(listing.presets.map((p) => p.path)).toContain("themes/tokyonight.toml");
    expect(listing.presets.every((p) => p.builtin)).toBe(true);
  });

  test("choosing a preset repaints the client", async ({ page, server }) => {
    await open(page, server);
    expect(await paperOf(page)).toBe("#0c151a");

    await page.keyboard.press(",");
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("button", { name: /tokyonight\.toml/ }).click();

    await expect.poll(() => paperOf(page)).toBe("#1a1b26");
  });

  test("a light preset flips color-scheme, not just the colours", async ({ page, server }) => {
    await open(page, server);

    await page.keyboard.press(",");
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("button", { name: /ecr-light\.toml/ }).click();

    await expect.poll(() => paperOf(page)).toBe("#fbfcfd");
    const scheme = await page.evaluate(() => document.documentElement.style.colorScheme);
    expect(scheme).toBe("light");
  });

  test("the choice survives a reload, because it lives in settings.toml", async ({
    page,
    server,
  }) => {
    await open(page, server);

    await page.keyboard.press(",");
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("button", { name: /nord\.toml/ }).click();
    await expect.poll(() => paperOf(page)).toBe("#2e3440");

    const config = await server.api<{ raw: string }>("/api/v1/config");
    expect(config.raw).toContain('theme = "themes/nord.toml"');

    await page.reload({ waitUntil: "networkidle" });
    await expect.poll(() => paperOf(page)).toBe("#2e3440");
  });

  test("a theme link cannot escape the config directory", async ({ server }) => {
    for (const path of ["../../../etc/passwd.toml", "/etc/passwd.toml", "themes/x.conf"]) {
      await expect(
        server.api(`/api/v1/theme?path=${encodeURIComponent(path)}`),
      ).rejects.toThrow(/40[03]/);
    }
  });
});
