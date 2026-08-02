import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConnection } from "../api/client";
import { createAppStore } from "./store";

// `shellServerUrl` is async; mock it so it never overrides the persisted URL.
vi.mock("../api/platform", () => ({
	shellServerUrl: vi.fn(),
}));

import { shellServerUrl } from "../api/platform";

/**
 * A stand-in for EventSource that records the listeners `api.events`
 * registers, so a test can dispatch a server event the way the server would.
 */
class FakeEventSource {
	static current: FakeEventSource | null = null;
	readonly handlers = new Map<string, (event: { data: string }) => void>();
	onerror: (() => void) | null = null;
	constructor(public url: string) {
		FakeEventSource.current = this;
	}
	addEventListener(name: string, handler: (event: { data: string }) => void): void {
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

describe("list pane auto-refresh", () => {
	let threadsCalls = 0;

	function stubFetch(): void {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (url: string) => ({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => {
					if (url.includes("/api/v1/threads?")) {
						threadsCalls++;
						return { revision: revision(), total: 0, items: [] };
					}
					if (url.includes("/api/v1/threads/")) return { messages: [] };
					if (url.includes("/api/v1/config")) return { path: "", raw: "" };
					if (url.includes("/api/v1/accounts"))
						return [{ id: "main", address: "main@x" }];
					if (url.includes("/api/v1/counts")) return { counts: [] };
					if (url.includes("/api/v1/lists")) return { lists: [], searchable: true };
					if (url.includes("/api/v1/themes")) return { presets: [] };
					return [];
				},
			})),
		);
	}

	beforeEach(() => {
		localStorage.clear();
		threadsCalls = 0;
		vi.mocked(shellServerUrl).mockResolvedValue(null);
		stubFetch();
		vi.stubGlobal("EventSource", FakeEventSource);
		FakeEventSource.current = null;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
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

	it("refreshes the inbox view on a server-pushed mail change", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });

		await withStore(async (store) => {
			await flush();
			// The store opens on the start query, `tag:inbox` (all accounts).
			expect(store.query()).toBe("tag:inbox");
			const before = threadsCalls;
			FakeEventSource.current!.dispatch("mail:changed", {
				type: "mail_changed",
				revision: revision(),
			});
			await flush();
			expect(threadsCalls).toBe(before + 1);
		});
	});

	it("does not refresh a non-inbox view on a server-pushed change", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });

		await withStore(async (store) => {
			await flush();
			store.selectQuery("tag:unread");
			await flush();
			expect(store.query()).toBe("tag:unread");

			const before = threadsCalls;
			FakeEventSource.current!.dispatch("mail:changed", {
				type: "mail_changed",
				revision: revision(),
			});
			await flush();
			expect(threadsCalls).toBe(before);
		});
	});

	it("still refreshes a non-inbox view when the user acts (bumpRevision)", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });

		await withStore(async (store) => {
			await flush();
			store.selectQuery("tag:unread");
			await flush();

			const before = threadsCalls;
			store.bumpRevision();
			await flush();
			expect(threadsCalls).toBe(before + 1);
		});
	});

	it("refreshes an account-scoped inbox on a server-pushed change", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });

		await withStore(async (store) => {
			await flush();
			// `(tag:inbox) and (tag:main)` is the main account's inbox view.
			const inbox = "(tag:inbox) and (tag:main)";
			store.selectQuery(inbox);
			await flush();
			expect(store.query()).toBe(inbox);

			const before = threadsCalls;
			FakeEventSource.current!.dispatch("tags:changed", {
				type: "tags_changed",
				revision: revision(),
				ids: ["a@x"],
			});
			await flush();
			expect(threadsCalls).toBe(before + 1);
		});
	});
});
