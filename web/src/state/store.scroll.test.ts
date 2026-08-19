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

/**
 * jsdom has no scrolling, so the pane stands in for one: what is under test is
 * which element is asked to move and how far, not that a browser can move it.
 */
function pane(clientHeight: number) {
	const moves: number[] = [];
	const element = {
		clientHeight,
		scrollBy: (options: { top: number }) => moves.push(options.top),
	} as unknown as HTMLElement;
	return { element, moves };
}

describe("the scroll chords drive the pane that has focus", () => {
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

	it("moves the focused pane by its own line and leaves the others alone", () => {
		createRoot((dispose) => {
			const store = createAppStore();
			const list = pane(400);
			const detail = pane(600);
			const sidebar = pane(300);

			store.setPaneScroller("list", list.element, () => 82);
			store.setPaneScroller("detail", detail.element);
			store.setPaneScroller("sidebar", sidebar.element, () => 28);

			store.setPane("list");
			store.scrollPane(1);
			store.scrollPane(-1);
			expect(list.moves).toEqual([82, -82]);

			store.setPane("sidebar");
			store.scrollPane(1);
			expect(sidebar.moves).toEqual([28]);

			// The detail pane's line is the store's own default: a message has no
			// row pitch to count in.
			store.setPane("detail");
			store.scrollPane(1);
			expect(detail.moves).toEqual([64]);

			// Each chord moved exactly one pane.
			expect(list.moves).toHaveLength(2);
			expect(sidebar.moves).toHaveLength(1);

			dispose();
		});
	});

	it("takes half a screen from the focused pane's own height", () => {
		createRoot((dispose) => {
			const store = createAppStore();
			const list = pane(400);
			const detail = pane(600);

			store.setPaneScroller("list", list.element, () => 82);
			store.setPaneScroller("detail", detail.element);

			store.setPane("list");
			store.scrollPane(1, true);
			expect(list.moves).toEqual([200]);
			expect(detail.moves).toEqual([]);

			dispose();
		});
	});

	it("does nothing when the focused pane has no scroller yet", () => {
		createRoot((dispose) => {
			const store = createAppStore();
			const detail = pane(600);
			store.setPaneScroller("detail", detail.element);

			store.setPane("sidebar");
			expect(() => store.scrollPane(1)).not.toThrow();
			expect(detail.moves).toEqual([]);

			dispose();
		});
	});

	it("forgets a pane that has gone away", () => {
		createRoot((dispose) => {
			const store = createAppStore();
			const list = pane(400);

			store.setPaneScroller("list", list.element, () => 82);
			store.setPaneScroller("list", null);

			store.setPane("list");
			store.scrollPane(1);
			expect(list.moves).toEqual([]);

			dispose();
		});
	});
});
