import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore } from "./store";

vi.mock("../api/platform", () => ({
	isTauri: vi.fn(),
	shellServerUrl: vi.fn(),
	shellToken: vi.fn(),
	notify: vi.fn(),
}));

import { notify, shellServerUrl } from "../api/platform";

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

const revision = () => ({ uuid: "uuid", lastmod: 1 });

/**
 * What the server would answer for `tag:inbox and tag:unread`.
 *
 * Mutable, because the whole of the new behaviour is a comparison against what
 * was there before: the store seeds a high-water mark when it subscribes, and
 * a test that cannot add to the inbox afterwards cannot make anything new.
 */
let inbox: unknown[] = [];

function arrival(over: Record<string, unknown> = {}) {
	return {
		id: "t1",
		subject: "Lunch on Thursday",
		authors: ["Ada Lovelace <ada@example.com>"],
		timestamp: 2_000,
		date_relative: "now",
		matched: 1,
		total: 1,
		tags: ["inbox", "unread"],
		newest_message: null,
		...over,
	};
}

describe("announcing new mail", () => {
	function stubFetch(): void {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (url: string) => ({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => {
					// Only the notification query answers with mail. The list is
					// left empty so that what is announced can only have come
					// from the query notifications are meant to use.
					if (url.includes("/api/v1/threads?")) {
						const forNotifications =
							url.includes("tag%3Ainbox") && url.includes("tag%3Aunread");
						return {
							revision: revision(),
							total: forNotifications ? inbox.length : 0,
							items: forNotifications ? inbox : [],
						};
					}
					if (url.includes("/api/v1/threads/")) return { messages: [] };
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
		inbox = [];
		vi.mocked(shellServerUrl).mockResolvedValue(null);
		vi.mocked(notify).mockClear();
		stubFetch();
		vi.stubGlobal("EventSource", FakeEventSource);
		FakeEventSource.current = null;
		// jsdom reports the document as focused, which is the one case that must
		// stay quiet. Unfocused is the interesting default here.
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

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

	const flush = () => new Promise((r) => setTimeout(r, 20));

	it("names who a finished sync brought mail from, and what about", async () => {
		await withStore(async () => {
			await flush();
			inbox = [arrival()];
			FakeEventSource.current?.dispatch("sync:finished", {
				type: "sync_finished",
				new_messages: 1,
				revision: revision(),
			});
			await flush();
			expect(notify).toHaveBeenCalledWith("Ada Lovelace", "Lunch on Thursday");
		});
	});

	/*
	 * The point of the whole change: a notification that says "3 new messages"
	 * tells somebody to go and look, and one that names the sender tells them
	 * whether they need to.
	 */
	it("collapses a burst into one notification naming the newest", async () => {
		await withStore(async () => {
			await flush();
			inbox = [
				arrival({ id: "a", timestamp: 2_000, subject: "Older" }),
				arrival({
					id: "b",
					timestamp: 9_000,
					subject: "Newest",
					authors: ["Grace Hopper <grace@example.org>"],
				}),
			];
			FakeEventSource.current?.dispatch("sync:finished", {
				type: "sync_finished",
				new_messages: 2,
				revision: revision(),
			});
			await flush();
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify).toHaveBeenCalledWith("Grace Hopper and 1 other", "Newest");
		});
	});

	/*
	 * Mail that a rule filed away, or that was read on another device, is not
	 * in `tag:inbox and tag:unread` — so the server answering nothing for that
	 * query has to mean silence, however many messages the sync reported.
	 */
	it("stays quiet when nothing is unread in the inbox", async () => {
		await withStore(async () => {
			await flush();
			inbox = [];
			FakeEventSource.current?.dispatch("sync:finished", {
				type: "sync_finished",
				new_messages: 7,
				revision: revision(),
			});
			await flush();
			expect(notify).not.toHaveBeenCalled();
		});
	});

	/*
	 * Opening ecr after a weekend must not announce Friday's mail. The mark is
	 * seeded when the client subscribes, so what was already there is not new.
	 */
	it("says nothing about mail that was already there when it started", async () => {
		inbox = [arrival({ timestamp: 5_000 })];
		await withStore(async () => {
			await flush();
			FakeEventSource.current?.dispatch("sync:finished", {
				type: "sync_finished",
				new_messages: 1,
				revision: revision(),
			});
			await flush();
			expect(notify).not.toHaveBeenCalled();
		});
	});

	it("says nothing about a sync that brought none", async () => {
		await withStore(async () => {
			await flush();
			FakeEventSource.current?.dispatch("sync:finished", {
				type: "sync_finished",
				new_messages: 0,
				revision: revision(),
			});
			await flush();
			expect(notify).not.toHaveBeenCalled();
		});
	});

	it("announces mail the watcher saw arrive outside a sync", async () => {
		await withStore(async () => {
			await flush();
			inbox = [arrival()];
			FakeEventSource.current?.dispatch("mail:changed", {
				type: "mail_changed",
				revision: revision(),
			});
			await flush();
			expect(notify).toHaveBeenCalledWith("Ada Lovelace", "Lunch on Thursday");
		});
	});

	// A sync writes into the maildir, so the watcher sees it too. Announcing
	// both would be one delivery reported twice, and the count is the better of
	// the two descriptions.
	it("stays quiet about a delivery during a sync", async () => {
		await withStore(async () => {
			await flush();
			FakeEventSource.current?.dispatch("sync:started", {
				type: "sync_started",
				accounts: ["main"],
			});
			FakeEventSource.current?.dispatch("mail:changed", {
				type: "mail_changed",
				revision: revision(),
			});
			await flush();
			expect(notify).not.toHaveBeenCalled();
		});
	});

	it("announces one arrival once, however it is described", async () => {
		await withStore(async () => {
			await flush();
			inbox = [arrival()];
			FakeEventSource.current?.dispatch("sync:finished", {
				type: "sync_finished",
				new_messages: 2,
				revision: revision(),
			});
			// The watcher catching up a moment after the sync reported it.
			FakeEventSource.current?.dispatch("mail:changed", {
				type: "mail_changed",
				revision: revision(),
			});
			await flush();
			expect(notify).toHaveBeenCalledTimes(1);
		});
	});

	it("says nothing while the window is the one being looked at", async () => {
		vi.mocked(document.hasFocus).mockReturnValue(true);
		await withStore(async () => {
			await flush();
			inbox = [arrival()];
			FakeEventSource.current?.dispatch("sync:finished", {
				type: "sync_finished",
				new_messages: 5,
				revision: revision(),
			});
			await flush();
			expect(notify).not.toHaveBeenCalled();
		});
	});

	it("obeys the preference", async () => {
		localStorage.setItem(
			"ecr.settings.toml",
			"[general]\nnotify_new_mail = false\n",
		);
		await withStore(async () => {
			await flush();
			inbox = [arrival()];
			FakeEventSource.current?.dispatch("sync:finished", {
				type: "sync_finished",
				new_messages: 4,
				revision: revision(),
			});
			await flush();
			expect(notify).not.toHaveBeenCalled();
		});
	});
});
