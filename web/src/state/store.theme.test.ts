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

/** What `GET /api/v1/theme` answers with, per test. */
type ThemeReply =
	| { kind: "ok"; raw: string }
	| { kind: "status"; status: number; body: unknown }
	| { kind: "offline" };

let theme: ThemeReply = { kind: "ok", raw: 'name = "t"\n' };
let configRaw = "";

function stubFetch(): void {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation(async (url: string) => {
			if (url.includes("/api/v1/theme?")) {
				const reply = theme;
				if (reply.kind === "offline") throw new TypeError("Load failed");
				if (reply.kind === "status")
					return {
						ok: false,
						status: reply.status,
						statusText: "no",
						json: async () => reply.body,
					};
				const raw = reply.raw;
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({ path: `/c/ecr/themes/x.toml`, raw }),
				};
			}

			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => {
					if (url.includes("/api/v1/config"))
						return { path: "/c/ecr/settings.toml", raw: configRaw };
					if (url.includes("/api/v1/threads"))
						return {
							revision: { uuid: "", lastmod: 0 },
							total: 0,
							items: [],
						};
					if (url.includes("/api/v1/counts")) return { counts: [] };
					if (url.includes("/api/v1/lists"))
						return { lists: [], searchable: true };
					return [];
				},
			};
		}),
	);
}

beforeEach(() => {
	localStorage.clear();
	theme = { kind: "ok", raw: 'name = "t"\n' };
	configRaw = "";
	vi.mocked(shellServerUrl).mockResolvedValue(null);
	stubFetch();
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

describe("a theme the server will not hand over", () => {
	it("reports the server's own reason, not a blanket one", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });
		theme = {
			kind: "status",
			status: 404,
			body: { error: "not_found", detail: "no theme at themes/ecr-dark.toml" },
		};

		await withStore(async (store) => {
			await flush();
			expect(store.settingsProblem()).toContain(
				"no theme at themes/ecr-dark.toml",
			);
		});
	});

	// The message used to land in `lastError`, which is painted only where the
	// thread list would be, under the heading "cannot reach the server" — so a
	// broken palette link read as an outage, and an outage read as a broken
	// palette, whichever request settled last.
	it("does not claim the server is unreachable", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });
		theme = {
			kind: "status",
			status: 404,
			body: { error: "not_found", detail: "no theme at themes/x.toml" },
		};

		await withStore(async (store) => {
			await flush();
			expect(store.lastError()).toBe("");
		});
	});

	it("says nothing about the theme when the server never answered", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });
		theme = { kind: "offline" };

		await withStore(async (store) => {
			await flush();
			expect(store.settingsProblem()).toBe("");
		});
	});

	it("retracts its complaint once a theme loads", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });
		theme = {
			kind: "status",
			status: 404,
			body: { error: "not_found", detail: "no theme at themes/x.toml" },
		};

		await withStore(async (store) => {
			await flush();
			expect(store.settingsProblem()).not.toBe("");

			theme = { kind: "ok", raw: 'name = "t"\n' };
			store.setTheme("themes/other.toml");
			await flush();
			expect(store.settingsProblem()).toBe("");
		});
	});

	// Both complaints share one slot, so a theme that loads must retract only
	// what the theme wrote: a bad line in settings.toml is still wrong.
	it("leaves a bad line in settings.toml standing", async () => {
		saveConnection({ baseUrl: "http://test:8383", token: "t" });
		configRaw = '[reading]\nnonsense_option = "x"\n';

		await withStore(async (store) => {
			await flush();
			expect(store.settingsProblem()).toContain("nonsense_option");
		});
	});
});
