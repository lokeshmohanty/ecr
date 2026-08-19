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

    const inbox = page.locator(row("Inbox")).first();
    await expect(inbox).toContainText(/\d/, { timeout: 15_000 });

    const { counts } = await server.api<{ counts: number[] }>("/api/v1/counts", {
      method: "POST",
      body: JSON.stringify({ queries: ["tag:inbox", "tag:unread"] }),
    });

    await expect(inbox).toContainText(String(counts[0]));
    await expect(page.locator(row("Unread")).first()).toContainText(String(counts[1]));
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
    await expect(page.locator(row("Inbox")).first()).toContainText(/\d/);
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

    for (const name of ["Tags", "Mailing Lists"]) {
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
    await expect(page.locator(row("Inbox")).first()).not.toContainText(/\d/);
  });

  test("turning icons off leaves the labels alone", async ({ page, server }) => {
    await configure(server, "[sidebar]\nsidebar_icons = false\n");

    await open(page, server);

    const inbox = page.locator(row("Inbox")).first();
    await expect(inbox).toBeVisible();
    await expect(inbox).not.toContainText("▣");
  });

  test("j and k walk the rows and Enter runs the one under the cursor", async ({
    page,
    server,
  }) => {
    await open(page, server);

    await page.keyboard.press("h");

    // The first row is the Inbox now that the account is a box above the list
    // rather than a heading in it, so `j` is the second mailbox and `k` is the
    // way back to the first.
    await page.keyboard.press("j");
    await page.keyboard.press("Enter");
    await expect(page.locator("#ecr-query")).toHaveValue(/tag:unread/);

    await page.keyboard.press("k");
    await page.keyboard.press("Enter");
    await expect(page.locator("#ecr-query")).toHaveValue(/tag:inbox/);
  });

  /**
   * The letters exist because the sidebar is the one pane where none of them
   * had anything to do — `s` is sync everywhere else, and a pane-scoped binding
   * beating an unscoped one is what lets it be Sent here without taking sync
   * away from anywhere it already worked.
   */
  test("a letter goes straight to its mailbox, and s is Sent rather than sync", async ({
    page,
    server,
  }) => {
    await open(page, server);
    await page.keyboard.press("h");

    await page.keyboard.press("s");
    await expect(page.locator("#ecr-query")).toHaveValue(/from:|tag:sent/);

    await page.keyboard.press("i");
    await expect(page.locator("#ecr-query")).toHaveValue(/tag:inbox/);

    await page.keyboard.press("f");
    await expect(page.locator("#ecr-query")).toHaveValue(/tag:flagged/);
  });

  /** A section has no query of its own, so its letter opens it and stops. */
  test("a section letter opens the section without loading anything", async ({
    page,
    server,
  }) => {
    await open(page, server);
    await page.keyboard.press("h");
    await page.keyboard.press("i");

    const tags = page.locator("[data-kind='section']").first();
    await expect(tags).toHaveAttribute("aria-expanded", "false");

    await page.keyboard.press("t");
    await expect(tags).toHaveAttribute("aria-expanded", "true");
    // Opening a fold is not choosing a mailbox: the list is where `i` left it.
    await expect(page.locator("#ecr-query")).toHaveValue(/tag:inbox/);

    // And it is a jump rather than a toggle — pressing it again must not undo
    // what it just did.
    await page.keyboard.press("t");
    await expect(tags).toHaveAttribute("aria-expanded", "true");
  });

  test("the account box opens the switcher", async ({ page, server }) => {
    await open(page, server);

    await page.locator("[data-account-box]").click();
    await expect(page.getByRole("dialog", { name: "Switch account" })).toBeVisible();
  });
  /**
   * Clicking a view left the keys pointed at the sidebar, so the `j` after it
   * walked to the next mailbox rather than the next thread — and the detail
   * pane, which follows the list cursor, went on showing the thread it already
   * had. It read as the reading pane having stopped updating.
   */
  test("clicking a view hands the keys to the list it just loaded", async ({ page, server }) => {
    await open(page, server);
    await page.waitForTimeout(500);

    await page.locator(row("All Mail")).first().click();
    await page.waitForTimeout(1500);
    const opened = await page.locator("h1").first().textContent();

    await page.keyboard.press("j");
    await expect(page.locator("h1").first()).not.toHaveText(opened ?? "", { timeout: 10_000 });
  });

  /**
   * The saved queries are the one client-scoped list, and localStorage is the
   * only place they live — so this is the only level at which saving one can be
   * checked end to end.
   */
  test("S files the current query under Queries, and it survives a reload", async ({
    page,
    server,
  }) => {
    await open(page, server);

    await page.keyboard.press("S");
    await page.keyboard.type("Saved inbox");
    await page.keyboard.press("Enter");

    const saved = page.locator(row("Saved inbox")).first();
    await expect(saved).toBeVisible();
    await expect(saved).toContainText(/\d/, { timeout: 15_000 });

    await page.reload();
    await expect(page.locator(row("Queries")).first()).toBeVisible();
  });
});
