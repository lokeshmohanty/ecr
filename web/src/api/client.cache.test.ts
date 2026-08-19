import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api } from "./client";
import type { Thread } from "./types";

vi.mock("./platform", () => ({ isTauri: vi.fn(() => false) }));

function message(id: string, tags: string[]) {
	return {
		id,
		thread_id: "t1",
		subject: "a subject",
		from: [],
		to: [],
		cc: [],
		bcc: [],
		reply_to: [],
		date: "",
		timestamp: 0,
		tags,
		in_reply_to: null,
		references: [],
		parts: [],
		excluded: false,
	};
}

function thread(id: string, ids: string[]): Thread {
	return {
		id,
		subject: "a subject",
		messages: ids.map((one) => message(one, ["inbox", "unread"])),
	} as unknown as Thread;
}

let answered: Record<string, unknown> = {};

function stubFetch(): ReturnType<typeof vi.fn> {
	const fetch = vi.fn().mockImplementation(async (url: string) => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => {
			for (const [needle, value] of Object.entries(answered)) {
				if (url.includes(needle)) return value;
			}
			return {};
		},
	}));
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

function api(): Api {
	return new Api({ baseUrl: "http://test:8383", token: "t" });
}

beforeEach(() => {
	answered = {};
	vi.unstubAllGlobals();
});

describe("what a tag write does to what is already held", () => {
	it("names itself, so the echo can be told from a stranger's", async () => {
		answered = { "/api/v1/tags": { uuid: "u", lastmod: 1 } };
		const fetch = stubFetch();
		const client = api();

		await client.tag([{ target: { message: "a@x" }, add: [], remove: [] }]);

		const body = JSON.parse(fetch.mock.calls[0]![1].body as string);
		expect(body.origin).toBe(client.origin);
		expect(client.origin).toBeTruthy();
	});

	/**
	 * The identity is the point. `createResource` compares what it resolved
	 * against what it holds, so a thread that comes back as the *same object*
	 * notifies nobody and the reading pane does not re-render — which is what
	 * keeps a tag change from reparsing every sandboxed message document.
	 */
	it("updates the cached thread in place rather than replacing it", async () => {
		answered = {
			"/api/v1/threads/": thread("t1", ["a@x", "b@x"]),
			"/api/v1/tags": { uuid: "u", lastmod: 1 },
		};
		stubFetch();
		const client = api();

		const before = await client.threadCached("t1");
		await client.tag([
			{ target: { message: "a@x" }, add: ["flagged"], remove: ["unread"] },
		]);
		const after = await client.threadCached("t1");

		expect(after).toBe(before);
		expect(after.messages[0]!.tags).toEqual(["flagged", "inbox"]);
		// Only what was named. The other message is untouched.
		expect(after.messages[1]!.tags).toContain("unread");
	});

	it("a thread op reaches every message in the thread", async () => {
		answered = {
			"/api/v1/threads/": thread("t1", ["a@x", "b@x"]),
			"/api/v1/tags": { uuid: "u", lastmod: 1 },
		};
		stubFetch();
		const client = api();

		await client.threadCached("t1");
		await client.tag([
			{ target: { thread: "t1" }, add: [], remove: ["unread"] },
		]);
		const after = await client.threadCached("t1");

		expect(after.messages.every((m) => !m.tags.includes("unread"))).toBe(true);
	});
});

describe("dropping a cached thread", () => {
	/**
	 * `tags:changed` reports whatever the ops targeted, and an op may name a
	 * message. Deleting by key alone kept the stale thread, and the failure is a
	 * conversation that goes on showing tags another client removed.
	 */
	it("finds the thread a message id belongs to", async () => {
		answered = { "/api/v1/threads/": thread("t1", ["a@x"]) };
		stubFetch();
		const client = api();

		await client.threadCached("t1");
		expect(client.cachedThread("t1")).toBeDefined();

		client.invalidate("a@x");
		expect(client.cachedThread("t1")).toBeUndefined();
	});

	it("with no name at all, everything goes", async () => {
		answered = { "/api/v1/threads/": thread("t1", ["a@x"]) };
		stubFetch();
		const client = api();

		await client.threadCached("t1");
		client.invalidate();
		expect(client.cachedThread("t1")).toBeUndefined();
	});

	it("leaves the threads it was not told about alone", async () => {
		answered = { "/api/v1/threads/": thread("t1", ["a@x"]) };
		stubFetch();
		const client = api();

		await client.threadCached("t1");
		client.invalidate("somebody-else");
		expect(client.cachedThread("t1")).toBeDefined();
	});
});
