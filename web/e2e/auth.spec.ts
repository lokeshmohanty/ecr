import { expect, ROW, test } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * The `page` fixture seeds the token every other spec runs with. This stacks a
 * second init script over it, so these tests start where a browser opened at
 * the server's address for the first time does: the right URL, no token.
 *
 * Guarded like the fixture's own, and for the same reason: an init script runs
 * again on every navigation, so an unguarded one would un-pair the device on
 * the reload that is meant to prove the pairing survived.
 */
async function unpaired(page: Page, url: string): Promise<void> {
  await page.addInitScript(
    ({ baseUrl }) => {
      try {
        if (localStorage.getItem("ecr.e2e.unpaired")) return;
        localStorage.setItem("ecr.e2e.unpaired", "1");
        localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl, token: "" }));
      } catch {
        /* sandboxed frame */
      }
    },
    { baseUrl: url },
  );
  await page.goto(url, { waitUntil: "networkidle" });
}

const ALERT = "dialog";

test.describe("authenticating a device", () => {
  test("a refused device is asked for a token, not told the server is down", async ({
    page,
    server,
  }) => {
    await unpaired(page, server.url);

    const alert = page.getByRole(ALERT, { name: /not authorised/i });
    await expect(alert).toBeVisible();
    // The one thing that is *not* wrong is the network, so the list must not
    // send the reader after it.
    await expect(page.getByText("cannot reach the server")).toHaveCount(0);
  });

  test("pasting the token loads the mail without a reload", async ({ page, server }) => {
    await unpaired(page, server.url);

    await page.getByLabel("Device token").fill(server.token);
    await page.getByRole("button", { name: /authenticate this device/i }).click();

    await expect(page.getByRole(ALERT)).toHaveCount(0);
    await page.waitForSelector(ROW, { timeout: 20_000 });
  });

  test("the token survives a reload, so a device is paired once", async ({ page, server }) => {
    await unpaired(page, server.url);

    await page.getByLabel("Device token").fill(server.token);
    await page.getByRole("button", { name: /authenticate this device/i }).click();
    await page.waitForSelector(ROW, { timeout: 20_000 });

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(ROW, { timeout: 20_000 });
    await expect(page.getByRole(ALERT)).toHaveCount(0);
  });

  // Saving a token before it is known to work leaves every pane empty with
  // nothing on screen to say why — the prompt that would say it having just
  // been dismissed by the thing that broke it.
  test("a wrong token is reported where it was typed and is not kept", async ({
    page,
    server,
  }) => {
    await unpaired(page, server.url);

    await page.getByLabel("Device token").fill("not-a-real-token");
    await page.getByRole("button", { name: /authenticate this device/i }).click();

    await expect(page.getByRole("alert")).toHaveText(/refused that token/i);
    await expect(page.getByRole(ALERT, { name: /not authorised/i })).toBeVisible();

    const stored = await page.evaluate(() => localStorage.getItem("ecr.connection"));
    expect(stored).not.toContain("not-a-real-token");
  });

  test("the prompt can be dismissed and asked for again", async ({ page, server }) => {
    await unpaired(page, server.url);

    await page.keyboard.press("Escape");
    await expect(page.getByRole(ALERT)).toHaveCount(0);

    // Fetching a token from the server takes as long as it takes, so the list
    // has to offer the way back in rather than leaving a reload as the only one.
    await page.getByRole("button", { name: "enter a token" }).click();
    await expect(page.getByRole(ALERT, { name: /not authorised/i })).toBeVisible();
  });
});
