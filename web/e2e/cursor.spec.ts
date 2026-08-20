import { expect, open, test, ROW, type Server } from "./fixtures";

const CURSOR = `${ROW}.row-card-selected`;

/**
 * Puts the inbox back.
 *
 * One server and one maildir per worker, shared by every spec in it and in
 * whatever order they run — so a test that archives mail changes what every
 * later test sees. This one archives on purpose, which makes it the only spec
 * that has to clean up after itself, and the failure it causes otherwise is
 * nothing like its cause: `list.spec.ts` reports the wrong *time* in a date
 * column, because the first row is no longer the thread it was written for.
 *
 * Archiving is only `-inbox`, so putting it back is exact rather than a guess.
 */
async function restoreInbox(server: Server, ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	await server.api("/api/v1/tags", {
		method: "POST",
		body: JSON.stringify({
			ops: ids.map((thread) => ({
				target: { thread },
				add: ["inbox"],
				remove: [],
			})),
		}),
	});
}

async function inboxThreads(server: Server): Promise<string[]> {
	const page = await server.api<{ items: { id: string }[] }>(
		"/api/v1/threads?query=tag%3Ainbox&limit=100",
	);
	return page.items.map((row) => row.id);
}

let started: string[] = [];

test.beforeEach(async ({ server }) => {
	started = await inboxThreads(server);
});

test.afterEach(async ({ server }) => {
	await restoreInbox(server, started);
});

const subjects = (page: import("@playwright/test").Page) =>
	page.locator(`${ROW} [data-subject]`);

const cursorSubject = (page: import("@playwright/test").Page) =>
	page.locator(`${CURSOR} [data-subject]`);

/**
 * The cursor is an index, and a list that loses rows keeps its indices. So an
 * action that takes mail out of the view left it pointing that many rows
 * further down than the thread it was on: the list scrolls, the cursor does
 * not go with it, and the next keystroke acts on something nobody chose.
 */
test.describe("the cursor when rows leave the list", () => {
	test("stays on its own thread when rows above it are archived", async ({
		page,
		server,
	}) => {
		await open(page, server);

		// Pick the second and third rows; `Space` steps on as it picks, so the
		// cursor ends on the fourth.
		await page.keyboard.press("j");
		await page.keyboard.press(" ");
		await page.keyboard.press(" ");

		const before = await cursorSubject(page).textContent();
		expect(before).toBeTruthy();

		const count = await subjects(page).count();

		await page.keyboard.press("a");
		await page.keyboard.press("x");

		// Two rows have left `tag:inbox`.
		await expect(subjects(page)).toHaveCount(count - 2);
		await expect(cursorSubject(page)).toHaveText(before!);
	});

	/**
	 * Reading down a mailbox and clearing it as you go should leave the cursor
	 * on the next thing to read — not below it by however many rows went.
	 */
	test("takes the next surviving row when its own thread is archived", async ({
		page,
		server,
	}) => {
		await open(page, server);

		const all = await subjects(page).allTextContents();
		expect(all.length).toBeGreaterThanOrEqual(4);

		// A range over the first two rows, which leaves the cursor on the second
		// — so the row it is on goes *and* the row above it goes with it. Keeping
		// the index would land one row below the answer, which is the failure;
		// clamping cannot hide it, because rows are left on both sides.
		await page.keyboard.press("v");
		await page.keyboard.press("j");
		await page.keyboard.press("a");
		await page.keyboard.press("x");

		await expect(subjects(page)).toHaveCount(all.length - 2);
		await expect(cursorSubject(page)).toHaveText(all[2]!);
	});
});
