import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConnection, saveConnection } from "../api/client";
import { createAppStore } from "./store";

vi.mock("../api/platform", () => ({
	shellServerUrl: vi.fn(),
	shellToken: vi.fn(),
	notify: vi.fn(),
	scanQr: vi.fn(),
}));

import { scanQr, shellServerUrl, shellToken } from "../api/platform";

/**
 * A server with a token store answers 401 to everything but `/api/v1/health`.
 * `accepted` is the token it will take; anything else is refused, which is what
 * a browser opened at the server's own address presents on its first visit.
 */
function stubServer(accepted: string | null): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		const bearer = headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
		const query = /access_token=([^&]+)/.exec(url)?.[1] ?? null;
		const presented = bearer ?? query;

		// The one public route, and the reason a refused device is not reported
		// as an unreachable one. A stub that guards it too would make the two
		// indistinguishable here in a way they are not against a real server.
		if (url.includes("/api/v1/health")) {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					tools: [],
					maildir_root: "/mail",
					database_path: "/mail/.notmuch",
					accounts: [],
					checks: [],
				}),
			};
		}

		if (accepted === null || presented !== accepted) {
			return {
				ok: false,
				status: 401,
				statusText: "Unauthorized",
				json: async () => ({
					error: "unauthorized",
					detail: "a valid bearer token is required",
				}),
			};
		}

		return {
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => {
				if (url.includes("/api/v1/config")) return { path: "", raw: "" };
				if (url.includes("/api/v1/threads"))
					return { revision: { uuid: "", lastmod: 0 }, total: 0, items: [] };
				if (url.includes("/api/v1/revision"))
					return { uuid: "", lastmod: 0 };
				if (url.includes("/api/v1/lists"))
					return { lists: [], searchable: true };
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
	vi.mocked(scanQr).mockReset();
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

describe("a server that refuses this device", () => {
	it("asks for a token rather than reporting an unreachable server", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "" });
		stubServer("good-token");

		await withStore((store) => {
			expect(store.needsToken()).toBe(true);
			expect(store.askingToken()).toBe(true);
		});
	});

	// `lastError` is painted under the heading *cannot reach the server*, and
	// this one answered. The prompt is what reports a refusal.
	it("does not report a refusal as an unreachable server", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "" });
		stubServer("good-token");

		await withStore((store) => {
			expect(store.needsToken()).toBe(true);
			expect(store.lastError()).toBe("");
			expect(store.status()).toBe("");
		});
	});

	// The address is right — this server answered. Asking for another one would
	// be asking the reader to fix a problem they do not have, over the prompt
	// that names the one they do.
	it("does not also ask for the address", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "" });
		stubServer("good-token");

		await withStore((store) => {
			expect(store.needsToken()).toBe(true);
			expect(store.reachable()).toBe(true);
			expect(store.askingServer()).toBe(false);
		});
	});

	it("stays quiet about the token while the server is answering", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "good-token" });
		stubServer("good-token");

		await withStore((store) => {
			expect(store.needsToken()).toBe(false);
			expect(store.askingToken()).toBe(false);
		});
	});
});

// Dismissing the prompt authorises nothing: the token has to be fetched from
// the server, and the client is still refused while that happens.
describe("dismissing the prompt", () => {
	it("leaves the refusal standing, so the list can offer the way back", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "" });
		stubServer("good-token");

		await withStore((store) => {
			expect(store.askingToken()).toBe(true);
			store.setAskingToken(false);
			expect(store.needsToken()).toBe(true);
		});
	});

	// A client left running against a revoked token refetches on every poll.
	it("is not reopened by the next request the server refuses", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "" });
		stubServer("good-token");

		await withStore(async (store) => {
			store.setAskingToken(false);
			await store.api.tags().catch(() => []);

			expect(store.askingToken()).toBe(false);
			expect(store.needsToken()).toBe(true);
		});
	});
});

describe("pairing a device with a pasted token", () => {
	it("keeps a token the server accepts and clears the prompt", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "" });
		stubServer("good-token");

		await withStore(async (store) => {
			expect(await store.authenticate("good-token")).toBe("");
			expect(store.needsToken()).toBe(false);
			expect(store.connection().token).toBe("good-token");
			expect(loadConnection().token).toBe("good-token");
		});
	});

	// A token saved before it is known to work leaves every pane empty with
	// nothing on screen to say why, and no way back to the field.
	it("refuses a token the server rejects without storing it", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "" });
		stubServer("good-token");

		await withStore(async (store) => {
			expect(await store.authenticate("wrong")).toBe(
				"the server refused that token",
			);
			expect(store.needsToken()).toBe(true);
			expect(store.connection().token).toBe("");
			expect(loadConnection().token).toBe("");
		});
	});

	it("says what to paste rather than checking an empty field", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "" });
		stubServer("good-token");

		await withStore(async (store) => {
			expect(await store.authenticate("   ")).toBe(
				"paste the token issued by ecr token new",
			);
		});
	});

	it("trims what was pasted", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "" });
		stubServer("good-token");

		await withStore(async (store) => {
			expect(await store.authenticate("  good-token\n")).toBe("");
			expect(store.connection().token).toBe("good-token");
		});
	});

	// Every resource keys on the token as well as the URL: keyed on the URL
	// alone, the panes whose requests were refused would stay empty behind the
	// prompt that just fixed them.
	it("refetches the threads a refusal emptied", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "" });
		const fetchMock = stubServer("good-token");

		await withStore(async (store) => {
			fetchMock.mockClear();
			await store.authenticate("good-token");
			await new Promise((resolve) => setTimeout(resolve, 0));

			const threads = fetchMock.mock.calls.filter(([url]) =>
				String(url).includes("/api/v1/threads"),
			);
			expect(threads.length).toBeGreaterThan(0);
			const headers = new Headers(threads.at(-1)?.[1]?.headers);
			expect(headers.get("authorization")).toBe("Bearer good-token");
		});
	});
});

// The camera is how a phone answers this prompt: the alternative is 64 hex
// characters on a soft keyboard. What the store does with what was read is
// tested here; `pairing.test.ts` covers the format itself.
describe("pairing a device by scanning a code", () => {
	it("keeps a token a bare code carried, against the address it already has", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "" });
		stubServer("good-token");
		vi.mocked(scanQr).mockResolvedValue({ kind: "scanned", text: "good-token" });

		await withStore(async (store) => {
			expect(await store.pairByScanning()).toBe("");
			expect(store.needsToken()).toBe(false);
			expect(store.connection()).toEqual({
				baseUrl: "http://host:8383",
				token: "good-token",
			});
		});
	});

	// The address first, then the token. Asking the old server whether the new
	// one's token is good either refuses something perfectly valid or accepts it
	// and leaves the device pointed where the reader has just stopped meaning.
	it("applies the address a code carried before the token", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "" });
		stubServer("good-token");
		vi.mocked(scanQr).mockResolvedValue({
			kind: "scanned",
			text: "ecr://pair?url=http%3A%2F%2Fbox%3A8383&token=good-token",
		});

		await withStore(async (store) => {
			expect(await store.pairByScanning()).toBe("");
			expect(store.connection()).toEqual({
				baseUrl: "http://box:8383",
				token: "good-token",
			});
			expect(store.needsToken()).toBe(false);
		});
	});

	// "" and nothing else changed: the prompt reads that as a camera the reader
	// waved away and stays where it is, rather than closing over a device that
	// is still refused.
	it("changes nothing and says nothing when the reader backs out", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "" });
		stubServer("good-token");
		vi.mocked(scanQr).mockResolvedValue({ kind: "cancelled" });

		await withStore(async (store) => {
			expect(await store.pairByScanning()).toBe("");
			expect(store.needsToken()).toBe(true);
			expect(store.connection().token).toBe("");
		});
	});

	it("reports a camera it may not use", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "" });
		stubServer("good-token");
		vi.mocked(scanQr).mockResolvedValue({
			kind: "unavailable",
			reason: "ecr may not use the camera; allow it in the system settings",
		});

		await withStore(async (store) => {
			expect(await store.pairByScanning()).toBe(
				"ecr may not use the camera; allow it in the system settings",
			);
			expect(store.needsToken()).toBe(true);
		});
	});

	it("refuses something that is not a pairing code without storing it", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "" });
		stubServer("good-token");
		vi.mocked(scanQr).mockResolvedValue({
			kind: "scanned",
			text: "https://example.com/some other qr",
		});

		await withStore(async (store) => {
			expect(await store.pairByScanning()).toBe(
				"that is not an ecr pairing code",
			);
			expect(store.connection().token).toBe("");
		});
	});

	// A code is scanned from the prompt that says the *token* is wrong, so a
	// token the server refuses has to say so there — not leave the device
	// pointed at the new address with the prompt gone.
	it("keeps the refusal standing when the scanned token is rejected", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "" });
		stubServer("good-token");
		vi.mocked(scanQr).mockResolvedValue({ kind: "scanned", text: "stale-token" });

		await withStore(async (store) => {
			expect(await store.pairByScanning()).toBe("the server refused that token");
			expect(store.connection().token).toBe("");
		});
	});
});

// A token revoked with `ecr token revoke` while a client is open refuses the
// next request it makes, from wherever in the app that request came.
describe("a token revoked mid-session", () => {
	it("raises the prompt from a request no pane reports on", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "good-token" });
		stubServer("good-token");

		await withStore(async (store) => {
			expect(store.needsToken()).toBe(false);

			stubServer(null);
			await store.api.tags().catch(() => []);

			expect(store.needsToken()).toBe(true);
		});
	});
});
