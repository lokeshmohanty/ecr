import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore } from "./store";

vi.mock("../api/platform", () => ({
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

describe("announcing new mail", () => {
	function stubFetch(): void {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (url: string) => ({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => {
					if (url.includes("/api/v1/threads?"))
						return { revision: revision(), total: 0, items: [] };
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

	it("announces a finished sync that brought mail", async () => {
		await withStore(async () => {
			await flush();
			FakeEventSource.current?.dispatch("sync:finished", {
				type: "sync_finished",
				new_messages: 3,
				revision: revision(),
			});
			await flush();
			expect(notify).toHaveBeenCalledWith("ecr", "3 new messages");
		});
	});

	it("counts one message in the singular", async () => {
		await withStore(async () => {
			await flush();
			FakeEventSource.current?.dispatch("sync:finished", {
				type: "sync_finished",
				new_messages: 1,
				revision: revision(),
			});
			await flush();
			expect(notify).toHaveBeenCalledWith("ecr", "1 new message");
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
			FakeEventSource.current?.dispatch("mail:changed", {
				type: "mail_changed",
				revision: revision(),
			});
			await flush();
			expect(notify).toHaveBeenCalledWith("ecr", "New mail");
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
