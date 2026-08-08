import { configure, expect, open, test } from "./fixtures";

/**
 * The status bar is one flex row that has to hold several things that each
 * want the whole width, and the failure mode is not a layout that looks
 * cramped — it is one that *overlaps*, painting two messages on top of each
 * other so neither can be read.
 *
 * It was found on the desktop client, against a real settings file, and no
 * suite would have caught it: the visual states carry no settings error, so
 * the two competing cells were never on screen at once. These tests put them
 * there and assert the geometry rather than the pixels, which is the only way
 * to state "these must not overlap" without a baseline to approve.
 */

// The status line, not the phone's action bar — both carry `chrome-bottom`.
const BAR = ".status-line";
const HINTS = `${BAR} .hint-row`;
const STATUS = `${BAR} .settings-problem, ${BAR} .status-text`;

/** A settings file with a bad line, so the status bar carries a long path. */
const BROKEN = `[general]
start_query = "tag:inbox"
mark_read_delay = "not a number"
`;

test.describe("the status bar", () => {
  /**
   * The one that was actually broken. Each hint is `shrink-0` — a keybinding
   * cut in half tells you nothing — so the hints span is routinely wider than
   * the space it is given, and without clipping the overflow is painted across
   * its neighbour rather than hidden.
   */
  test("key hints never paint over the message beside them", async ({
    page,
    server,
  }) => {
    await configure(server, BROKEN);
    await page.setViewportSize({ width: 1000, height: 800 });
    await open(page, server);

    const status = page.locator(STATUS).first();
    await expect(status).toBeVisible();

    const statusBox = await status.boundingBox();
    expect(statusBox).not.toBeNull();

    /*
     * The *container* is what must stop, not each hint. Hints are `shrink-0`
     * — a keybinding cut in half tells you nothing — so individual boxes
     * routinely extend past the space available; `overflow-hidden` is what
     * keeps them from being painted there. So the invariant is that the
     * clipping box never reaches into the status cell, and anything that does
     * not fit inside it is simply not drawn.
     */
    const hints = await page.locator(HINTS).boundingBox();
    expect(hints).not.toBeNull();

    expect(
      hints!.x + hints!.width,
      "the key hints reach into the status cell beside them",
    ).toBeLessThanOrEqual(statusBox!.x + 1);
  });

  /**
   * The bar must stay one line. A wrap pushes it off the bottom of the window
   * on the desktop, where the chrome is a fixed height, so the mode indicator
   * and the marked count disappear rather than moving.
   */
  test("stays a single row however much it is carrying", async ({
    page,
    server,
  }) => {
    await configure(server, BROKEN);
    await page.setViewportSize({ width: 820, height: 800 });
    await open(page, server);

    const bar = page.locator(BAR);
    const box = await bar.boundingBox();
    expect(box).not.toBeNull();

    // Two lines of this type would be past 48px; one is comfortably under.
    expect(box!.height).toBeLessThan(48);
  });

  /**
   * A bad line in the settings file is still wrong until somebody edits it, so
   * it outlives the transient status rather than being overwritten by the next
   * thing that happened.
   */
  test("reports a bad settings line where it can be read", async ({
    page,
    server,
  }) => {
    await configure(server, BROKEN);
    await page.setViewportSize({ width: 1200, height: 800 });
    await open(page, server);

    const problem = page.locator(`${BAR} .settings-problem`);
    await expect(problem).toBeVisible();
    // The line number is the whole point: "something is wrong with your
    // settings" sends somebody to read the entire file.
    await expect(problem).toContainText("line");
  });

  /**
   * The body must never scroll sideways, and a status bar that overflows its
   * container is one of the two ways that happens.
   */
  test("does not push the window into a horizontal scroll", async ({
    page,
    server,
  }) => {
    await configure(server, BROKEN);
    await page.setViewportSize({ width: 900, height: 800 });
    await open(page, server);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
