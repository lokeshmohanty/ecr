import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDelayed } from "./delayed";

/** Lets the effect that `createDelayed` registers run before we assert. */
async function settle(): Promise<void> {
	await Promise.resolve();
}

describe("createDelayed", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("says nothing about a wait shorter than the threshold", async () => {
		await createRoot(async (dispose) => {
			const [pending, setPending] = createSignal(true);
			const shown = createDelayed(pending);
			await settle();

			// The warm path: twelve milliseconds, which is the case that made the
			// old indicator read as a stutter.
			vi.advanceTimersByTime(12);
			setPending(false);
			await settle();

			vi.advanceTimersByTime(1000);
			expect(shown()).toBe(false);
			dispose();
		});
	});

	it("reports a wait that outlasts the threshold", async () => {
		await createRoot(async (dispose) => {
			const [pending] = createSignal(true);
			const shown = createDelayed(pending);
			await settle();

			vi.advanceTimersByTime(199);
			expect(shown()).toBe(false);

			vi.advanceTimersByTime(1);
			expect(shown()).toBe(true);
			dispose();
		});
	});

	it("keeps it on screen long enough to be read", async () => {
		await createRoot(async (dispose) => {
			const [pending, setPending] = createSignal(true);
			const shown = createDelayed(pending);
			await settle();

			vi.advanceTimersByTime(200);
			expect(shown()).toBe(true);

			// Landing ten milliseconds after it appeared would otherwise be the
			// same flash one threshold later.
			vi.advanceTimersByTime(10);
			setPending(false);
			await settle();
			expect(shown()).toBe(true);

			vi.advanceTimersByTime(290);
			expect(shown()).toBe(false);
			dispose();
		});
	});

	it("does not strobe when a second wait starts inside the floor", async () => {
		await createRoot(async (dispose) => {
			const [pending, setPending] = createSignal(true);
			const shown = createDelayed(pending);
			await settle();

			vi.advanceTimersByTime(200);
			expect(shown()).toBe(true);

			setPending(false);
			await settle();
			vi.advanceTimersByTime(50);
			setPending(true);
			await settle();

			// The hide that was scheduled must have been cancelled, not merely
			// outrun: it stays up across the whole of the next wait.
			vi.advanceTimersByTime(1000);
			expect(shown()).toBe(true);
			dispose();
		});
	});
});
