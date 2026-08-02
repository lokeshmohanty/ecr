import { describe, expect, it } from "vitest";
import {
	parseAddress,
	rankAddresses,
	suggestQuery,
	recipientFragment,
	completeRecipient,
} from "./suggest";

describe("query suggestions", () => {
	it("treats a bare word as a tag when one matches", () => {
		const values = suggestQuery("unre", ["unread", "inbox"]).map(
			(s) => s.value,
		);
		expect(values).toContain("tag:unread");
	});

	it("suggests nothing for a bare word with no matching tag", () => {
		expect(suggestQuery("zzz", ["unread"])).toEqual([]);
	});

	it("suggests tags that match what is typed", () => {
		const suggestions = suggestQuery("tag:inb", ["inbox", "unread", "flagged"]);
		expect(suggestions[0]!.value).toBe("tag:inbox");
	});

	it("suggests every tag when the prefix has no fragment yet", () => {
		const suggestions = suggestQuery("tag:", ["inbox", "unread"]);
		expect(suggestions.map((s) => s.value)).toEqual([
			"tag:inbox",
			"tag:unread",
		]);
	});

	it("completes only the last term, leaving earlier ones intact", () => {
		const suggestions = suggestQuery("tag:inbox and tag:unr", ["unread"]);
		expect(suggestions[0]!.value).toBe("tag:inbox and tag:unread");
	});

	it("offers the search prefixes themselves", () => {
		const values = suggestQuery("fr", []).map((s) => s.value);
		expect(values).toContain("from:");
	});

	it("returns nothing for an empty query", () => {
		expect(suggestQuery("", [])).toEqual([]);
	});

	it("never returns more than a screenful", () => {
		const tags = Array.from({ length: 500 }, (_, i) => `tag${i}`);
		expect(suggestQuery("tag:tag", tags).length).toBeLessThanOrEqual(12);
	});

	it("each suggestion carries a description", () => {
		for (const suggestion of suggestQuery("tag:inb", ["inbox"])) {
			expect(suggestion.detail.length).toBeGreaterThan(0);
		}
	});
});

describe("parsing an address book entry", () => {
	it("splits a named address", () => {
		expect(parseAddress("Alice Smith <alice@example.com>")).toEqual({
			name: "Alice Smith",
			email: "alice@example.com",
		});
	});

	it("handles a bare address", () => {
		expect(parseAddress("bob@example.com")).toEqual({
			name: null,
			email: "bob@example.com",
		});
	});

	it("strips quotes around a name", () => {
		expect(parseAddress('"Doe, Jane" <l@x.com>')).toEqual({
			name: "Doe, Jane",
			email: "l@x.com",
		});
	});

	it("ignores an entry with no address", () => {
		expect(parseAddress("   ")).toBeNull();
		expect(parseAddress("Just A Name")).toBeNull();
	});
});

const BOOK = [
	{ name: "Alice Smith", email: "alice@example.com" },
	{ name: "Bob Jones", email: "bob@corp.example.com" },
	{ name: null, email: "carol@example.com" },
	{ name: "Alice Zhang", email: "azhang@other.com" },
];

describe("ranking addresses", () => {
	it("matches on the address", () => {
		expect(rankAddresses(BOOK, "alice").map((a) => a.email)).toContain(
			"alice@example.com",
		);
	});

	it("matches on the display name", () => {
		expect(rankAddresses(BOOK, "zhang").map((a) => a.email)).toContain(
			"azhang@other.com",
		);
	});

	it("is case-insensitive", () => {
		expect(rankAddresses(BOOK, "ALICE").length).toBeGreaterThan(0);
	});

	it("prefers a prefix match over one in the middle", () => {
		const ranked = rankAddresses(BOOK, "bob");
		expect(ranked[0]!.email).toBe("bob@corp.example.com");
	});

	it("returns everything for an empty fragment", () => {
		expect(rankAddresses(BOOK, "")).toHaveLength(BOOK.length);
	});

	it("returns nothing when nothing matches", () => {
		expect(rankAddresses(BOOK, "zzzz")).toEqual([]);
	});

	it("caps the list", () => {
		const big = Array.from({ length: 200 }, (_, i) => ({
			name: null,
			email: `a${i}@x.com`,
		}));
		expect(rankAddresses(big, "a").length).toBeLessThanOrEqual(8);
	});
});

describe("the recipient fragment being typed", () => {
	it("finds the fragment after the last comma", () => {
		expect(recipientFragment("alice@x.com, bo", 15)).toEqual({
			fragment: "bo",
			start: 13,
		});
	});

	it("finds the first fragment when there is no comma", () => {
		expect(recipientFragment("ali", 3)).toEqual({ fragment: "ali", start: 0 });
	});

	it("trims the leading space after a comma", () => {
		expect(recipientFragment("alice@x.com, bo", 16)).toEqual({
			fragment: "bo",
			start: 13,
		});
	});

	it("returns an empty fragment at the start of a new term", () => {
		expect(recipientFragment("alice@x.com, ", 13)).toEqual({
			fragment: "",
			start: 13,
		});
	});
});

describe("replacing the fragment with a chosen address", () => {
	it("substitutes the fragment and leaves a trailing comma", () => {
		const result = completeRecipient(
			"alice@x.com, bo",
			13,
			15,
			"bob@corp.example.com",
		);
		expect(result.text).toBe("alice@x.com, bob@corp.example.com, ");
		expect(result.caret).toBe(result.text.length);
	});

	it("substitutes a lone fragment", () => {
		const result = completeRecipient("ali", 0, 3, "alice@example.com");
		expect(result.text).toBe("alice@example.com, ");
	});
});
