import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConnection } from "../api/client";
import { createAppStore } from "./store";

vi.mock("../api/platform", () => ({
	isTauri: vi.fn(),
	shellServerUrl: vi.fn(),
	shellToken: vi.fn(),
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
	addEventListener(name: string, handler: (event: { data: string }) => void) {
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

const THREAD = {
	id: "thread-1",
	subject: "a subject",
	messages: [
		{
			id: "a@x",
			thread_id: "thread-1",
			subject: "a subject",
			from: [],
			to: [],
			cc: [],
			bcc: [],
			reply_to: [],
			date: "",
			timestamp: 0,
			tags: ["inbox", "unread"],
			in_reply_to: null,
			references: [],
			parts: [],
			excluded: false,
		},
	],
};

beforeEach(() => {
	localStorage.clear();
	vi.mocked(shellServerUrl).mockResolvedValue(null);
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation(async (url: string) => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => {
				if (url.includes("/api/v1/threads/")) return THREAD;
				if (url.includes("/api/v1/threads?"))
					return { revision: revision(), total: 0, items: [] };
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
	vi.stubGlobal("EventSource", FakeEventSource);
	FakeEventSource.current = null;
});

afterEach(() => vi.unstubAllGlobals());

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

/**
 * A tag write is published to everybody, the writer included, and the writer
 * has nothing to learn from it: it sent the ops and `Api.tag` has already
 * written them into what it holds. Acting on the echo means dropping the cache
 * and fetching the open thread back over the network to arrive at what is
 * already on screen — once per message read, since marking one read is a tag
 * write.
 */
describe("a tag change this client made", () => {
	it("does not drop what it has already brought up to date", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });

		await withStore(async (store) => {
			await flush();
			await store.api.threadCached("thread-1");
			expect(store.api.cachedThread("thread-1")).toBeDefined();

			FakeEventSource.current!.dispatch("tags:changed", {
				type: "tags_changed",
				revision: revision(),
				ids: ["thread-1"],
				origin: store.api.origin,
			});
			await flush();

			expect(store.api.cachedThread("thread-1")).toBeDefined();
		});
	});

	it("but a stranger's write drops the threads it names", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });

		await withStore(async (store) => {
			await flush();
			await store.api.threadCached("thread-1");

			FakeEventSource.current!.dispatch("tags:changed", {
				type: "tags_changed",
				revision: revision(),
				ids: ["thread-1"],
				origin: "some-other-client",
			});
			await flush();

			expect(store.api.cachedThread("thread-1")).toBeUndefined();
		});
	});

	/** A server too old to say who wrote is a server nothing can be kept from. */
	it("and an event that claims nobody is treated as a stranger's", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });

		await withStore(async (store) => {
			await flush();
			await store.api.threadCached("thread-1");

			FakeEventSource.current!.dispatch("tags:changed", {
				type: "tags_changed",
				revision: revision(),
				ids: [],
			});
			await flush();

			expect(store.api.cachedThread("thread-1")).toBeUndefined();
		});
	});
});
