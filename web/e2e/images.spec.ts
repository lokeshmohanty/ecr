import { configure, expect, open, test, ROW } from "./fixtures";

/**
 * `multipart_related.eml`: one inline image referenced by `cid:`, one remote
 * one on a host that does not exist. It is the only fixture with either, and
 * it is the whole of what these tests need.
 */
const RELATED = "id:mime1@example.com";

/**
 * Opens the one thread this query matches, and waits for it rather than for a
 * row to exist.
 *
 * `createResource` keeps the previous page while a new key is in flight, so
 * the inbox's rows are still on screen the moment Enter is pressed — a wait
 * for `ROW` is satisfied by them, and the Enter that follows opens whichever
 * inbox thread the cursor was on. It passes or fails on how fast the fixture
 * server answered, which is the worst way for a test to be wrong.
 */
const openOnly = async (page: import("@playwright/test").Page, query: string) => {
  await page.keyboard.press("/");
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");

  await expect(page.locator(ROW)).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Hello" })).toBeVisible();
};

/** The message, read as text rather than as HTML. */
const asText = async (page: import("@playwright/test").Page) => {
  await page.keyboard.press("l");
  await page.getByRole("button", { name: /as plain text/ }).click();
  const body = page.locator("main pre");
  await expect(body).toBeVisible();
  return body;
};

/**
 * Nothing may leave the machine. The remote image points at a host that does
 * not resolve, and how long that takes to say so is the network's business
 * rather than the client's — see `keepOffline` in `web/browser.mjs`, which is
 * the same guard for the other suites.
 */
const offline = async (page: import("@playwright/test").Page, base: string) => {
  const origin = new URL(base).origin;
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === origin || url.hostname === "127.0.0.1"
      ? route.continue()
      : route.abort();
  });
};

test.describe("images in a message", () => {
  /**
   * The reading text is markdown, and an image is the one piece of its
   * punctuation that stands in for something rather than decorating it. Left
   * as `![](…)` it is a line of URL between the sentences, which is why the
   * conversion used to drop images entirely.
   */
  test("the plain-text view renders an inline image rather than its markup", async ({
    page,
    server,
  }) => {
    await offline(page, server.url);
    await open(page, server);
    await openOnly(page, RELATED);

    const body = await asText(page);
    // The server resolved `cid:` to a part of this message; the client made it
    // absolute so an `<img>` in the app's own document can reach the API.
    await expect(body.getByAltText("logo")).toHaveAttribute(
      "src",
      /\/api\/v1\/messages\/.*\/parts\/\d+/,
    );
    await expect(body).not.toContainText("![");
  });

  /**
   * The privacy setting governs the text view as well. It used to be an HTML
   * question only, because the text view had no images to have an opinion
   * about.
   */
  test("turning remote images off blocks them in the plain-text view too", async ({
    page,
    server,
  }) => {
    await configure(server, "[reading]\nload_remote_images = false\n");

    await offline(page, server.url);
    await open(page, server);
    await openOnly(page, RELATED);

    const body = await asText(page);
    await expect(body).not.toContainText("tracker.example.com");
    // The inline part is local, and is never what "remote" means.
    await expect(body.locator("img")).toHaveCount(1);
  });

  /** The default, which is what most mail is written to be read as. */
  test("remote images are loaded without being asked for", async ({
    page,
    server,
  }) => {
    await offline(page, server.url);
    await open(page, server);
    await openOnly(page, RELATED);

    // No affordance to load them, because there is nothing left to load.
    await expect(page.getByText(/remote image/)).toHaveCount(0);
  });
});
