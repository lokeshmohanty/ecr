import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConnection } from "../api/client";
import type { ThreadSummary } from "../api/types";
import { createAppStore } from "./store";

vi.mock("../api/platform", () => ({
	shellServerUrl: vi.fn(),
	// A factory mock replaces the whole module, so anything the store imports
	// from it has to appear here. Leaving `notify` out made it `undefined`, and
	// calling it threw straight through the server-event handler — the list
	// stopped refreshing on new mail, which looked nothing like a missing mock.
	notify: vi.fn(),
}));

import { shellServerUrl } from "../api/platform";

class FakeEventSource {
	static current: FakeEventSource | null = null;
	readonly handlers = new Map<string, (event: { data: string }) => void>();
	onerror: (() => void) | null = null;
	constructor(public url: string) {
		FakeEventSource.current = this;
	}
	addEventListener(
		name: string,
		handler: (event: { data: string }) => void,
	): void {
		this.handlers.set(name, handler);
	}
	close(): void {
		/* no-op */
	}
	dispatch(name: string, payload: unknown): void {
		this.handlers.get(name)?.({ data: JSON.stringify(payload) });
	}
}

function revision() {
	return { uuid: "uuid", lastmod: 1 };
}

const ROW: ThreadSummary = {
	id: "thread-1",
	subject: "still there",
	authors: ["someone"],
	timestamp: 1_775_000_000,
	date_relative: "today",
	matched: 1,
	total: 1,
	tags: ["inbox", "unread"],
	newest_message: "a@x",
};

describe("rows held after they stop matching the query", () => {
	/** The page the next `/threads` call answers with. */
	let page: ThreadSummary[] = [ROW];

	function stubFetch(): void {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (url: string) => ({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => {
					if (url.includes("/api/v1/threads?"))
						return { revision: revision(), total: page.length, items: page };
					if (url.includes("/api/v1/threads/"))
						return {
							messages: [
								{
									id: "a@x",
									thread_id: ROW.id,
									subject: ROW.subject,
									from: [],
									to: [],
									cc: [],
									bcc: [],
									reply_to: [],
									date: "",
									timestamp: ROW.timestamp,
									tags: ["inbox", "unread"],
									in_reply_to: null,
									references: [],
									parts: [],
									excluded: false,
								},
							],
						};
					if (url.includes("/api/v1/config")) return { path: "", raw: "" };
					if (url.includes("/api/v1/accounts"))
						return [{ id: "main", address: "main@x" }];
					if (url.includes("/api/v1/counts")) return { counts: [] };
					if (url.includes("/api/v1/lists"))
						return { lists: [], searchable: true };
					if (url.includes("/api/v1/themes")) return { presets: [] };
					return [];
				},
			})),
		);
	}

	beforeEach(() => {
		localStorage.clear();
		page = [ROW];
		vi.mocked(shellServerUrl).mockResolvedValue(null);
		// A 1ms delay settles the mark-read timer within a flush.
		localStorage.setItem(
			"ecr.settings.toml",
			"[reading]\nmark_read_delay = 1\n",
		);
		stubFetch();
		vi.stubGlobal("EventSource", FakeEventSource);
		FakeEventSource.current = null;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const flush = () => new Promise((r) => setTimeout(r, 20));

	function withStore(
		assert: (store: ReturnType<typeof createAppStore>) => Promise<void>,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			createRoot(async (dispose) => {
				try {
					const store = createAppStore();
					store.subscribe();
					await assert(store);
					dispose();
					resolve();
				} catch (error) {
					dispose();
					reject(error);
				}
			});
		});
	}

	/** Opens `tag:unread`, reads the row, and lets the mark-read write land. */
	async function readTheRow(store: ReturnType<typeof createAppStore>) {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });
		await flush();
		store.selectQuery("tag:unread");
		await flush();
		expect(store.items()).toHaveLength(1);

		store.setOpenThread(ROW.id);
		store.markReadWhenSeen("a@x", ["unread"]);
		await flush();
		await flush();
		// The server no longer matches it: reading dropped `unread`.
		page = [];
	}

	it("marks the row read in place when the query still matches it", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });

		await withStore(async (store) => {
			await flush();
			store.selectQuery("tag:inbox");
			await flush();
			expect(store.items()[0]?.tags).toContain("unread");

			store.setOpenThread(ROW.id);
			store.markReadWhenSeen("a@x", ["unread"]);
			await flush();
			await flush();

			// The list is not refetched, so the page still says unread; the row
			// reads as read anyway, in the position it was already in.
			expect(store.items()).toHaveLength(1);
			expect(store.items()[0]?.id).toBe(ROW.id);
			expect(store.items()[0]?.tags).not.toContain("unread");
			expect(store.items()[0]?.tags).toContain("inbox");
		});
	});

	it("keeps the row when new mail refetches the list under it", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });

		await withStore(async (store) => {
			await readTheRow(store);

			FakeEventSource.current!.dispatch("mail:changed", {
				type: "mail_changed",
				revision: revision(),
			});
			await flush();

			expect(store.items()).toHaveLength(1);
			expect(store.items()[0]?.id).toBe(ROW.id);
			// It is held as it now is, not as it was fetched.
			expect(store.items()[0]?.tags).not.toContain("unread");
			// And the thread being read stays open.
			expect(store.openThread()).toBe(ROW.id);
		});
	});

	it("drops the row on a sync", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });

		await withStore(async (store) => {
			await readTheRow(store);

			await store.sync();
			await flush();
			expect(store.items()).toHaveLength(0);
		});
	});

	it("drops the row when staged tags are written", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });

		await withStore(async (store) => {
			await readTheRow(store);

			store.mark("archive");
			await store.executeMarks();
			await flush();
			expect(store.items()).toHaveLength(0);
		});
	});

	it("drops the row on a change of view, and does not bring it back", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });

		await withStore(async (store) => {
			await readTheRow(store);

			store.selectQuery("tag:inbox");
			await flush();
			expect(store.items()).toHaveLength(0);

			store.selectQuery("tag:unread");
			await flush();
			expect(store.items()).toHaveLength(0);
		});
	});
});
