import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConnection } from "../api/client";
import { createAppStore } from "./store";

// The desktop shell exposes its server URL through a Tauri command. The store
// must treat that as authoritative for a launch — a value persisted from an
// earlier run must not shadow ECR_SERVER_URL.
vi.mock("../api/platform", () => ({
	shellServerUrl: vi.fn(),
}));

import { shellServerUrl } from "../api/platform";

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
