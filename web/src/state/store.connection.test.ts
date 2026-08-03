import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConnection } from "../api/client";
import { createAppStore } from "./store";

// The desktop shell exposes its server URL and, for a dev launch, its token
// through Tauri commands. The store must treat the URL as authoritative for a
// launch — a value persisted from an earlier run must not shadow
// ECR_SERVER_URL — and the token as a fallback, which is the other way round.
vi.mock("../api/platform", () => ({
	shellServerUrl: vi.fn(),
	shellToken: vi.fn(),
}));

import { shellServerUrl, shellToken } from "../api/platform";

// createAppStore fires fetches through its resources and the settings effect;
// none of them matter to the connection under test, so they resolve to empty,
// well-shaped values that keep those code paths quiet.
function stubFetch(): void {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation(async (url: string) => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => {
				if (url.includes("/api/v1/config")) return { path: "", raw: "" };
				if (url.includes("/api/v1/threads"))
					return { revision: { uuid: "", lastmod: 0 }, total: 0, items: [] };
				return [];
			},
		})),
	);
}

beforeEach(() => {
	localStorage.clear();
	vi.mocked(shellServerUrl).mockReset();
	vi.mocked(shellToken).mockReset();
	stubFetch();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// createAppStore needs a reactive root, and the shell URL arrives on the
// microtask queue, so settle it with a macrotask before asserting.
function withStore(
	assert: (store: ReturnType<typeof createAppStore>) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		createRoot((dispose) => {
			const store = createAppStore();
			setTimeout(() => {
				try {
					assert(store);
					dispose();
					resolve();
				} catch (error) {
					dispose();
					reject(error);
				}
			}, 0);
		});
	});
}

describe("desktop shell server URL", () => {
	it("overrides a persisted URL with the shell's ECR_SERVER_URL", async () => {
		saveConnection({ baseUrl: "http://stale:9999", token: "tok" });
		vi.mocked(shellServerUrl).mockResolvedValue("http://env:1234");

		await withStore((store) => {
			expect(store.connection().baseUrl).toBe("http://env:1234");
			expect(store.connection().token).toBe("tok");
		});
	});

	it("keeps a persisted connection when the shell offers no URL (browser)", async () => {
		saveConnection({ baseUrl: "http://host:8383", token: "t" });
		vi.mocked(shellServerUrl).mockResolvedValue(null);

		await withStore((store) => {
			expect(store.connection().baseUrl).toBe("http://host:8383");
			expect(store.connection().token).toBe("t");
		});
	});

	it("does not rewrite the connection when the shell URL already matches", async () => {
		saveConnection({ baseUrl: "http://env:1234", token: "tok" });
		vi.mocked(shellServerUrl).mockResolvedValue("http://env:1234");

		await withStore((store) => {
			expect(store.connection().baseUrl).toBe("http://env:1234");
			expect(store.connection().token).toBe("tok");
		});
	});
});

// `just desktop` and `just android` hand the shell a dev token, because a
// client the server does not serve itself never sees a `?token=` URL.
describe("desktop shell token", () => {
	it("adopts the shell's token when nothing is stored", async () => {
		vi.mocked(shellServerUrl).mockResolvedValue("http://env:1234");
		vi.mocked(shellToken).mockResolvedValue("dev-token");

		await withStore((store) => {
			expect(store.connection().token).toBe("dev-token");
			expect(store.connection().baseUrl).toBe("http://env:1234");
		});
	});

	// A paired device outranks a dev launch, or running `just desktop` once
	// would overwrite the token that device was actually paired with.
	it("keeps a stored token over the shell's", async () => {
		saveConnection({ baseUrl: "http://env:1234", token: "paired" });
		vi.mocked(shellServerUrl).mockResolvedValue("http://env:1234");
		vi.mocked(shellToken).mockResolvedValue("dev-token");

		await withStore((store) => {
			expect(store.connection().token).toBe("paired");
		});
	});

	it("leaves the token empty in a browser, where the shell offers none", async () => {
		vi.mocked(shellServerUrl).mockResolvedValue(null);
		vi.mocked(shellToken).mockResolvedValue(null);

		await withStore((store) => {
			expect(store.connection().token).toBe("");
		});
	});
});
