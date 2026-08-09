import { describe, expect, it } from "vitest";
import {
	NOTIFY_QUERY,
	announcementFor,
	arrivedSince,
	newestTimestamp,
	senderName,
} from "./announce";
import type { ThreadSummary } from "../api/types";

function thread(over: Partial<ThreadSummary> = {}): ThreadSummary {
	return {
		id: "t1",
		subject: "Lunch on Thursday",
		authors: ["Ada Lovelace <ada@example.com>"],
		timestamp: 1_000,
		date_relative: "now",
		matched: 1,
		total: 1,
		tags: ["inbox", "unread"],
		newest_message: null,
		...over,
	};
}

describe("what a notification is drawn from", () => {
	/*
	 * Both halves of the query earn their place. Without `inbox` a filing rule
	 * that files something away still buzzes the phone, which is the opposite
	 * of what the rule is for; without `unread` a message read on another
	 * device is announced here, and "new mail" that has already been read is
	 * how somebody learns to ignore notifications.
	 */
	it("asks only for unread mail that is in the inbox", () => {
		expect(NOTIFY_QUERY).toContain("tag:inbox");
		expect(NOTIFY_QUERY).toContain("tag:unread");
	});
});

describe("who a notification says it is from", () => {
	it("prefers the name a person would recognise", () => {
		expect(senderName(["Ada Lovelace <ada@example.com>"])).toBe("Ada Lovelace");
	});

	it("falls back to the address when there is no name", () => {
		expect(senderName(["<ada@example.com>"])).toBe("ada@example.com");
		expect(senderName(["ada@example.com"])).toBe("ada@example.com");
	});

	/* Real senders quote names containing commas: `"Lovelace, Ada" <a@b.c>`. */
	it("strips the quotes a comma in the name forces", () => {
		expect(senderName(['"Lovelace, Ada" <ada@example.com>'])).toBe(
			"Lovelace, Ada",
		);
	});

	/* A notification with an empty title reads as a bug, not as a message. */
	it("always says something, even with nothing to go on", () => {
		expect(senderName([])).toBe("Unknown sender");
		expect(senderName(["   "])).toBe("Unknown sender");
	});
});

describe("what a notification says", () => {
	it("names the sender and the subject of a single arrival", () => {
		const announcement = announcementFor([thread()]);

		expect(announcement?.title).toBe("Ada Lovelace");
		expect(announcement?.body).toBe("Lunch on Thursday");
	});

	/*
	 * Mail arrives in bursts — a sync after a laptop wakes delivers everything
	 * at once — and one notification per message is a phone that buzzes forty
	 * times and gets muted.
	 */
	it("collapses a burst into one, counting the rest", () => {
		const announcement = announcementFor([
			thread({ id: "a", timestamp: 1_000, subject: "Older" }),
			thread({
				id: "b",
				timestamp: 3_000,
				subject: "Newest",
				authors: ["Grace Hopper <grace@example.org>"],
			}),
			thread({ id: "c", timestamp: 2_000, subject: "Middle" }),
		]);

		// The newest is the one named, whatever order they arrived in.
		expect(announcement?.title).toBe("Grace Hopper and 2 others");
		expect(announcement?.body).toBe("Newest");
	});

	it("does not say `1 others`", () => {
		const announcement = announcementFor([
			thread({ id: "a", timestamp: 1_000 }),
			thread({ id: "b", timestamp: 2_000 }),
		]);

		expect(announcement?.title).toContain("1 other");
		expect(announcement?.title).not.toContain("1 others");
	});

	/* An empty body reads as a broken notification rather than a blank subject. */
	it("says something for a message with no subject", () => {
		expect(announcementFor([thread({ subject: "   " })])?.body).toBe(
			"(no subject)",
		);
	});

	/* So the caller never has to decide whether nothing is worth announcing. */
	it("answers nothing when nothing arrived", () => {
		expect(announcementFor([])).toBeNull();
	});
});

describe("knowing what is actually new", () => {
	it("counts only what arrived after the last one announced", () => {
		const threads = [
			thread({ id: "old", timestamp: 1_000 }),
			thread({ id: "new", timestamp: 5_000 }),
		];

		expect(arrivedSince(threads, 2_000).map((t) => t.id)).toEqual(["new"]);
	});

	/*
	 * Two messages can share a second, and announcing the same one twice is
	 * worse than missing a simultaneous arrival the next event carries anyway.
	 */
	it("treats a thread exactly at the mark as already seen", () => {
		expect(arrivedSince([thread({ timestamp: 2_000 })], 2_000)).toEqual([]);
	});

	/*
	 * The mark is what stops opening ecr after a weekend announcing mail from
	 * Friday.
	 */
	it("takes the high-water mark from whatever is there", () => {
		expect(
			newestTimestamp([thread({ timestamp: 10 }), thread({ timestamp: 70 })]),
		).toBe(70);
	});

	/* An empty inbox must not reset the mark and re-announce everything. */
	it("keeps the previous mark when there is nothing to raise it", () => {
		expect(newestTimestamp([], 500)).toBe(500);
	});
});
