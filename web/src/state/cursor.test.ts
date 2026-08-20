import { describe, expect, it } from "vitest";
import { followCursor } from "./cursor";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

describe("keeping the cursor on the mail it was on", () => {
	it("follows its thread when rows above it go", () => {
		// Cursor on `d`; `a` and `b` were archived out from above it.
		expect(followCursor(["a", "b", "c", "d"], 3, rows("c", "d"))).toBe(1);
	});

	it("stays put when nothing moved", () => {
		expect(followCursor(["a", "b", "c"], 1, rows("a", "b", "c"))).toBe(1);
	});

	/* The whole point: clear as you read, and land on the next thing to read. */
	it("takes the next surviving row when its own thread went", () => {
		expect(followCursor(["a", "b", "c", "d"], 1, rows("a", "d"))).toBe(1);
	});

	it("skips a run of removed rows rather than counting them", () => {
		expect(followCursor(["a", "b", "c", "d", "e"], 1, rows("a", "e"))).toBe(1);
	});

	/* Nothing below survived, so the end of the list is the nearest thing. */
	it("falls back to the last surviving row above", () => {
		expect(followCursor(["a", "b", "c"], 2, rows("a"))).toBe(0);
	});

	it("follows its thread when new mail arrives above it", () => {
		expect(followCursor(["a", "b"], 1, rows("new", "a", "b"))).toBe(2);
	});

	/**
	 * A fresh query has nothing to follow, and must not: two mailboxes can hold
	 * the same thread, and jumping to it because the *previous* view had the
	 * cursor near it would move the cursor for a reason nobody could see.
	 */
	it("does not follow anything across a change of query", () => {
		expect(followCursor([], 5, rows("a", "b", "c"))).toBe(2);
	});

	it("answers zero for a list with nothing in it", () => {
		expect(followCursor(["a"], 0, [])).toBe(0);
	});

	it("clamps a cursor past the end", () => {
		expect(followCursor([], 99, rows("a", "b"))).toBe(1);
	});
});
