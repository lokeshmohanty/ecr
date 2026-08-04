import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasConnection, loadConnection, saveConnection } from "./client";

vi.mock("./platform", () => ({ isTauri: vi.fn() }));

import { isTauri } from "./platform";

beforeEach(() => {
	localStorage.clear();
	vi.mocked(isTauri).mockReset();
});

describe("loadConnection", () => {
	it("returns what was stored, whatever a default would say", () => {
		saveConnection({ baseUrl: "http://mail.lan:8383", token: "paired" });
		vi.mocked(isTauri).mockReturnValue(true);

		expect(loadConnection()).toEqual({
			baseUrl: "http://mail.lan:8383",
			token: "paired",
		});
	});

	// The origin under a shell is the webview's own — `tauri://localhost` on the
	// desktop, but `http://tauri.localhost` on Android, which passes the origin
	// test and would leave a fresh install asking itself for mail.
	it("does not mistake a shell's own origin for a server", () => {
		vi.mocked(isTauri).mockReturnValue(true);

		expect(loadConnection().baseUrl).toBe("http://localhost:8383");
	});

	it("starts at the origin it was served from in a browser", () => {
		vi.mocked(isTauri).mockReturnValue(false);

		expect(loadConnection().baseUrl).toBe(location.origin);
	});

	it("survives a stored value that is not JSON", () => {
		localStorage.setItem("ecr.connection", "{not json");
		vi.mocked(isTauri).mockReturnValue(false);

		expect(hasConnection(loadConnection())).toBe(true);
	});
});
