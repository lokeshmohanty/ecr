import { configure, expect, open, test } from "./fixtures";

const row = (name: string) => `nav [data-row]:has-text("${name}")`;

test.describe("sidebar", () => {
  /**
   * The regression this exists for: counts were written into a store keyed by
   * query, and a reader that had already read a missing key was never woken. It
   * looked fine against a warm config directory, because an unrelated settings
   * update re-rendered the sidebar a moment later. Only a cold server showed it,
   * and every worker here starts cold.
   */
  test("counts appear and agree with the API", async ({ page, server }) => {
    await open(page, server);

    const inbox = page.locator(row("INBOX")).first();
    await expect(inbox).toContainText(/\d/, { timeout: 15_000 });

    const { counts } = await server.api<{ counts: number[] }>("/api/v1/counts", {
      method: "POST",
      body: JSON.stringify({ queries: ["tag:inbox", "tag:unread"] }),
    });

    await expect(inbox).toContainText(String(counts[0]));
    await expect(page.locator(row("UNREAD")).first()).toContainText(String(counts[1]));
  });

  test("a count is asked for once per query, not once per row render", async ({
    page,
    server,
  }) => {
    const posted: string[] = [];
    await page.route("**/api/v1/counts", async (route) => {
      posted.push(route.request().postData() ?? "");
      await route.continue();
    });

    await open(page, server);
    await expect(page.locator(row("INBOX")).first()).toContainText(/\d/);
    await page.waitForTimeout(1000);

    const asked = posted.flatMap((body) => JSON.parse(body).queries as string[]);
    expect(new Set(asked).size, `duplicate queries in ${JSON.stringify(asked)}`).toBe(
      asked.length,
    );
  });

  test("the gathered sections fold open and closed", async ({ page, server }) => {
    await open(page, server);

    const tags = page.locator(row("Tags")).first();
    await expect(tags).toHaveAttribute("aria-expanded", "false");

    await tags.click();
    await expect(tags).toHaveAttribute("aria-expanded", "true");

    await tags.click();
    await expect(tags).toHaveAttribute("aria-expanded", "false");
  });

  test("every gathered section is present by default", async ({ page, server }) => {
    await open(page, server);

    for (const name of ["Tags", "People", "Mailing lists"]) {
      await expect(page.locator(row(name)).first()).toBeVisible();
    }
  });

  test("turning counts off stops the requests entirely", async ({ page, server }) => {
    let requests = 0;
    await page.route("**/api/v1/counts", async (route) => {
      requests += 1;
      await route.continue();
    });

    await configure(server, "[sidebar]\nsidebar_counts = false\n");

    await open(page, server);
    await page.waitForTimeout(1500);

    expect(requests).toBe(0);
    await expect(page.locator(row("INBOX")).first()).not.toContainText(/\d/);
  });

  test("turning icons off leaves the labels alone", async ({ page, server }) => {
    await configure(server, "[sidebar]\nsidebar_icons = false\n");

    await open(page, server);

    const inbox = page.locator(row("INBOX")).first();
    await expect(inbox).toBeVisible();
    await expect(inbox).not.toContainText("▣");
  });

  test("j and k walk the rows and Enter runs the one under the cursor", async ({
    page,
    server,
  }) => {
    await open(page, server);

    await page.keyboard.press("h");
    await page.keyboard.press("j");
    await page.keyboard.press("Enter");

    await expect(page.locator("#ecr-query")).toHaveValue(/tag:inbox/);
  });
});
