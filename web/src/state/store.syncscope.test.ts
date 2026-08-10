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
	readonly handlers = new Map<string, (event: { data: string }) => void>();
	onerror: (() => void) | null = null;
	constructor(public url: string) {}
	addEventListener(
		name: string,
		handler: (event: { data: string }) => void,
	): void {
		this.handlers.set(name, handler);
	}
	close(): void {
		/* no-op */
	}
}

/**
 * A sync fetches every folder of every account it is given, so a manual sync
 * that always sent them all cost most of a minute of three other mailboxes to
 * refresh the one on screen. What is asserted here is the request body, which
 * is the thing that was wrong — the report the client shows back is identical
 * either way, so nothing visible would have caught this.
 */
describe("a manual sync follows the view on screen", () => {
	/** The `accounts` array of the last POST to /api/v1/sync. */
	let asked: string[] | null = null;

	function stubFetch(): void {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
				if (url.includes("/api/v1/sync")) {
					asked = JSON.parse(String(init?.body ?? "{}")).accounts;
					return {
						ok: true,
						status: 200,
						statusText: "OK",
						json: async () => ({ new_messages: 0, accounts: [] }),
					};
				}
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => {
						if (url.includes("/api/v1/threads?"))
							return {
								revision: { uuid: "uuid", lastmod: 1 },
								total: 0,
								items: [],
							};
						if (url.includes("/api/v1/config")) return { path: "", raw: "" };
						if (url.includes("/api/v1/accounts"))
							return [
								{ id: "main", address: "main@x" },
								{ id: "iisc", address: "iisc@x" },
							];
						if (url.includes("/api/v1/counts")) return { counts: [] };
						if (url.includes("/api/v1/lists"))
							return { lists: [], searchable: true };
						if (url.includes("/api/v1/themes")) return { presets: [] };
						return [];
					},
				};
			}),
		);
	}

	beforeEach(() => {
		localStorage.clear();
		asked = null;
		vi.mocked(shellServerUrl).mockResolvedValue(null);
		stubFetch();
		vi.stubGlobal("EventSource", FakeEventSource);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	async function syncFrom(query: string): Promise<string[] | null> {
		return await createRoot(async (dispose) => {
			saveConnection({ baseUrl: "http://localhost:8383", token: "t" });
			const store = createAppStore();
			// The account list is a resource, and `accountLabel` can only
			// recognise an account it has been told about. Until it resolves
			// every query looks account-less — which is the safe answer (sync
			// everything) but not the one under test here.
			await new Promise((r) => setTimeout(r, 20));
			store.setQuery(query);
			await store.sync();
			dispose();
			return asked;
		});
	}

	it("sends only the account the query names", async () => {
		expect(await syncFrom("tag:inbox and tag:main")).toEqual(["main"]);
	});

	it("recognises an account named by path as well as by tag", async () => {
		expect(await syncFrom('path:"iisc/Inbox/**"')).toEqual(["iisc"]);
	});

	/// A view across accounts is wrong the moment any one of them is stale, so
	/// naming none of them asks for all of them — the empty list the route
	/// already reads as everything.
	it("asks for everything when the query names no account", async () => {
		expect(await syncFrom("tag:inbox")).toEqual([]);
	});
});
