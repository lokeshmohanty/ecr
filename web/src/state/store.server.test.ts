import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConnection, saveConnection } from "../api/client";
import { createAppStore } from "./store";

vi.mock("../api/platform", () => ({
	shellServerUrl: vi.fn(),
	shellToken: vi.fn(),
	notify: vi.fn(),
}));

import { shellServerUrl, shellToken } from "../api/platform";

interface Check {
	name: string;
	status: "ok" | "warn" | "fail";
	detail: string;
	hint: string | null;
}

/**
 * A server listening at exactly one address. Anything else is a connection that
 * never arrives — which is what a wrong host, a stopped server and a phone off
 * the network all present as, and the reason they share one fix.
 */
function stubServer(options: { at: string | null; checks?: Check[] }) {
	const fetchMock = vi.fn().mockImplementation(async (url: string) => {
		if (options.at === null || !String(url).startsWith(options.at)) {
			throw new TypeError("Failed to fetch");
		}

		return {
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => {
				if (url.includes("/api/v1/health"))
					return {
						tools: [],
						maildir_root: "/mail",
						database_path: "/mail/.notmuch",
						accounts: [],
						checks: options.checks ?? [],
					};
				if (url.includes("/api/v1/config")) return { path: "", raw: "" };
				if (url.includes("/api/v1/threads"))
					return { revision: { uuid: "", lastmod: 0 }, total: 0, items: [] };
				if (url.includes("/api/v1/revision")) return { uuid: "", lastmod: 0 };
				if (url.includes("/api/v1/lists")) return { lists: [], searchable: true };
				if (url.includes("/api/v1/themes")) return { presets: [] };
				return [];
			},
		};
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	localStorage.clear();
	vi.mocked(shellServerUrl).mockReset().mockResolvedValue(null);
	vi.mocked(shellToken).mockReset().mockResolvedValue(null);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function withStore(
	assert: (store: ReturnType<typeof createAppStore>) => void | Promise<void>,
): Promise<void> {
	return new Promise((resolve, reject) => {
		createRoot((dispose) => {
			const store = createAppStore();
			setTimeout(() => {
				void (async () => {
					try {
						await assert(store);
						dispose();
						resolve();
					} catch (error) {
						dispose();
						reject(error);
					}
				})();
			}, 0);
		});
	});
}

describe("an address nothing answers at", () => {
	it("is reported as unreachable rather than as a refusal", async () => {
		saveConnection({ baseUrl: "http://wrong:8383", token: "t" });
		stubServer({ at: "http://right:8383" });

		await withStore((store) => {
			expect(store.reachable()).toBe(false);
			expect(store.needsToken()).toBe(false);
		});
	});

	// A client that has never reached the address it was given has no mail to
	// cover and nothing else to offer.
	it("raises the address prompt by itself", async () => {
		saveConnection({ baseUrl: "http://wrong:8383", token: "t" });
		stubServer({ at: "http://right:8383" });

		await withStore((store) => {
			expect(store.askingServer()).toBe(true);
		});
	});

	// A server that stays down would otherwise reopen the dialog under whoever
	// just dismissed it, on every poll.
	it("does not reopen the prompt once it has been dismissed", async () => {
		saveConnection({ baseUrl: "http://wrong:8383", token: "t" });
		stubServer({ at: "http://right:8383" });

		await withStore(async (store) => {
			store.setAskingServer(false);
			store.retryServer();
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(store.askingServer()).toBe(false);
			expect(store.reachable()).toBe(false);
		});
	});
});

describe("entering an address", () => {
	it("keeps one that answers, and stores it", async () => {
		saveConnection({ baseUrl: "http://wrong:8383", token: "t" });
		stubServer({ at: "http://right:8383" });

		await withStore(async (store) => {
			expect(await store.reachServer("http://right:8383")).toBe("");
			expect(store.connection().baseUrl).toBe("http://right:8383");
			expect(loadConnection().baseUrl).toBe("http://right:8383");
			expect(store.askingServer()).toBe(false);
		});
	});

	// An address saved because it was typed leaves every pane empty with nothing
	// on screen to say the host was wrong, and no way back to the one that
	// worked — the same reason a token is proved before it is kept.
	it("refuses one that answers nothing, without storing it", async () => {
		saveConnection({ baseUrl: "http://right:8383", token: "t" });
		stubServer({ at: "http://right:8383" });

		await withStore(async (store) => {
			expect(await store.reachServer("http://nowhere:8383")).toContain(
				"did not answer",
			);
			expect(store.connection().baseUrl).toBe("http://right:8383");
			expect(loadConnection().baseUrl).toBe("http://right:8383");
		});
	});

	it("names the missing scheme rather than trying the address without one", async () => {
		saveConnection({ baseUrl: "http://right:8383", token: "t" });
		const fetchMock = stubServer({ at: "http://right:8383" });

		await withStore(async (store) => {
			fetchMock.mockClear();
			expect(await store.reachServer("right:8383")).toContain("scheme");
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	it("says what to enter rather than probing an empty field", async () => {
		saveConnection({ baseUrl: "", token: "" });
		stubServer({ at: "http://right:8383" });

		await withStore(async (store) => {
			expect(await store.reachServer("  ")).toContain("ecr serve");
		});
	});

	it("drops a trailing slash, so the base is not doubled", async () => {
		saveConnection({ baseUrl: "", token: "" });
		stubServer({ at: "http://right:8383" });

		await withStore(async (store) => {
			expect(await store.reachServer("http://right:8383/")).toBe("");
			expect(store.connection().baseUrl).toBe("http://right:8383");
		});
	});

	/*
	 * An address is changed far more often to reach the same server by another
	 * name — localhost from the machine it runs on, an address on the network
	 * from a phone — than to reach a different one. A token that does turn out to
	 * belong elsewhere is a 401, which has a prompt of its own.
	 */
	it("carries the token over rather than making the device pair again", async () => {
		saveConnection({ baseUrl: "http://localhost:8383", token: "paired" });
		stubServer({ at: "http://box.lan:8383" });

		await withStore(async (store) => {
			await store.reachServer("http://box.lan:8383");
			expect(store.connection().token).toBe("paired");
		});
	});
});

describe("a server that started with warnings", () => {
	const warning: Check = {
		name: "oauth main",
		status: "warn",
		detail: "the refresh token has expired",
		hint: "run `ecr oauth authorize main`",
	};

	it("gathers the checks that are not ok, failures first", async () => {
		saveConnection({ baseUrl: "http://right:8383", token: "t" });
		stubServer({
			at: "http://right:8383",
			checks: [
				{ name: "notmuch", status: "ok", detail: "", hint: null },
				warning,
				{ name: "maildir", status: "fail", detail: "missing", hint: null },
			],
		});

		await withStore((store) => {
			expect(store.serverChecks().map((c) => c.name)).toEqual([
				"maildir",
				"oauth main",
			]);
		});
	});

	// They are not this client's to fix, but they are what a reader otherwise
	// experiences as mail that quietly does not arrive.
	it("keeps its hint, which is the only thing that names the fix", async () => {
		saveConnection({ baseUrl: "http://right:8383", token: "t" });
		stubServer({ at: "http://right:8383", checks: [warning] });

		await withStore((store) => {
			expect(store.serverChecks()[0]?.hint).toBe(
				"run `ecr oauth authorize main`",
			);
		});
	});

	it("says nothing when every check passed", async () => {
		saveConnection({ baseUrl: "http://right:8383", token: "t" });
		stubServer({ at: "http://right:8383" });

		await withStore((store) => {
			expect(store.serverChecks()).toEqual([]);
			expect(store.askingServer()).toBe(false);
		});
	});
});

/*
 * `lastError` is painted under the heading *cannot reach the server*, so a save
 * the server actively refused would send the reader to their network over a
 * server that had answered. It belongs in the slot that survives, beside the
 * bad-line reports, because the option is on screen as chosen and is not what
 * the server holds.
 */
describe("settings the server would not store", () => {
	it("reports a refusal as a settings problem, not as an outage", async () => {
		saveConnection({ baseUrl: "http://right:8383", token: "t" });
		const fetchMock = stubServer({ at: "http://right:8383" });

		await withStore(async (store) => {
			// Only the write is refused. A read-only server serves mail perfectly
			// well, which is exactly why reporting this as an outage is wrong.
			const working = fetchMock.getMockImplementation();
			fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
				if (url.includes("/api/v1/config") && init?.method === "PUT") {
					return {
						ok: false,
						status: 403,
						statusText: "Forbidden",
						json: async () => ({ error: "read_only", detail: "read-only" }),
					};
				}
				return working?.(url, init);
			});

			store.setSettings(store.settings());
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(store.settingsProblem()).toContain("read-only");
			expect(store.lastError()).toBe("");
		});
	});

	it("retracts its own complaint once a save lands", async () => {
		saveConnection({ baseUrl: "http://right:8383", token: "t" });
		const fetchMock = stubServer({ at: "http://right:8383" });

		await withStore(async (store) => {
			const working = fetchMock.getMockImplementation();
			fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
				if (url.includes("/api/v1/config") && init?.method === "PUT") {
					return {
						ok: false,
						status: 403,
						statusText: "Forbidden",
						json: async () => ({ error: "read_only", detail: "read-only" }),
					};
				}
				return working?.(url, init);
			});

			store.setSettings(store.settings());
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(store.settingsProblem()).not.toBe("");

			fetchMock.mockImplementation(working!);
			store.setSettings(store.settings());
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(store.settingsProblem()).toBe("");
		});
	});
});
