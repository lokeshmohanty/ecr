import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore } from "./store";

vi.mock("../api/platform", () => ({
	isTauri: vi.fn(),
	shellServerUrl: vi.fn(),
	shellToken: vi.fn(),
	notify: vi.fn(),
}));

class SilentEventSource {
	addEventListener(): void {}
	close(): void {}
	onerror: (() => void) | null = null;
}

describe("a pane blinks when focus shifts to it", () => {
	beforeEach(() => {
		vi.stubGlobal("EventSource", SilentEventSource);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({}),
				text: async () => "",
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		localStorage.clear();
	});

	it("names the pane focus moved to, and nothing before one moves", () => {
		createRoot((dispose) => {
			const store = createAppStore();
			expect(store.paneFlash()).toBeNull();

			store.setPane("sidebar");
			expect(store.paneFlash()).toBe("sidebar");

			store.focusPane(1);
			expect(store.pane()).toBe("list");
			expect(store.paneFlash()).toBe("list");

			dispose();
		});
	});

	it("does not retrigger while focus stays put", () => {
		createRoot((dispose) => {
			const store = createAppStore();
			store.setPane("list");
			expect(store.paneFlash()).toBeNull();

			// A capture-click on the pane it is already in must not blink.
			store.setPane("list");
			expect(store.paneFlash()).toBeNull();

			dispose();
		});
	});

	it("retriggers on returning to a pane it left", () => {
		createRoot((dispose) => {
			const store = createAppStore();
			store.setPane("detail");
			expect(store.paneFlash()).toBe("detail");

			// Leaving is what takes the class off; coming back must put it on
			// again, or the second visit would arrive unannounced.
			store.setPane("list");
			store.setPane("detail");
			expect(store.paneFlash()).toBe("detail");

			dispose();
		});
	});
});
