import { expect, open, test, type Server } from "./fixtures";

/**
 * A message that has been written and has not gone.
 *
 * The fixture's msmtp config names no host, so every send from it fails —
 * which is the state this suite is about. Before the outbox strip existed the
 * client's account of that failure was *nothing at all*: the composer closed,
 * Sent stayed empty because that copy comes back from the provider rather than
 * from here, and the only record was a line in the server's log. The reader is
 * left believing a message was sent.
 */
test.describe("the outbox", () => {
  const strip = "text=/outbox ·/";

  /**
   * Queued through the API rather than the composer: what is under test is
   * what the client does with a queue, and driving the editor to get one is
   * three more things that can break in a test about something else.
   */
  async function queue(server: Server) {
    await server.api("/api/v1/send", {
      method: "POST",
      // The draft is flattened into the request, not nested under `draft`.
      body: JSON.stringify({
        account: "main",
        hold: 0,
        to: ["nobody@example.invalid"],
        cc: [],
        bcc: [],
        subject: "a message that cannot go",
        body: "hello",
        in_reply_to: null,
        references: [],
        attachments: [],
      }),
    });
  }

  test("shows a failed send, with the reason and a way to try again", async ({
    page,
    server,
  }) => {
    await open(page, server);
    await queue(server);

    // The drain runs on a timer and the failure arrives over the event stream,
    // so this is the client being told rather than the test polling the API.
    await expect(page.locator(strip)).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText("a message that cannot go"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "try again" }),
    ).toBeVisible({ timeout: 30_000 });
  });

  /** Discarding is the other half: a queue with no way out is a trap. */
  test("a queued message can be discarded", async ({ page, server }) => {
    await open(page, server);
    await queue(server);

    // Waits for the failure rather than discarding the moment the row appears:
    // a message that is *being sent* has been claimed, and the server refuses
    // to take back one it may already have delivered. Clicking into that race
    // tests the race and not the button.
    await expect(page.getByRole("button", { name: "try again" })).toBeVisible({
      timeout: 30_000,
    });
    // Retried, because the server refuses to take back a message it has
    // already claimed and is dialling out with — the right answer, and one a
    // single click can land in by luck of the retry timer.
    await expect(async () => {
      await page.getByRole("button", { name: "discard" }).first().click();
      await expect(page.locator(strip)).toBeHidden({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
  });
});
