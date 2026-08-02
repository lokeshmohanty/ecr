import { describe, expect, it } from "vitest";
import {
	badgesFor,
	isMessageOpen,
	markToOps,
	parseTagInput,
	DEFAULT_VIEWS,
	MARK_TAGS,
	type Mark,
} from "./store";
import { tagsWithoutAccounts } from "./store/sidebar";

/** What the store stages for one message. */
const staged = (marks: Mark[], add: string[] = [], remove: string[] = []) => ({
	marks,
	add,
	remove,
});

describe("message folding", () => {
	/** What `za` does: store the negation of whatever is showing now. */
	const toggle = (
		explicit: boolean | undefined,
		newest: boolean,
		expandNewest: boolean,
	) => isMessageOpen(explicit, newest, expandNewest);

	it("expands the newest message when the preference says so", () => {
		expect(isMessageOpen(undefined, true, true)).toBe(true);
		expect(isMessageOpen(undefined, true, false)).toBe(false);
	});

	it("leaves older messages collapsed by default", () => {
		expect(isMessageOpen(undefined, false, true)).toBe(false);
	});

	it("lets an explicit fold override the default in both directions", () => {
		expect(isMessageOpen(false, false, false)).toBe(true);
		expect(isMessageOpen(true, true, true)).toBe(false);
	});

	it("opens a collapsed older message on the first toggle", () => {
		// The bug: storing !undefined recorded it as collapsed, so it never opened.
		const stored = toggle(undefined, false, true);
		expect(isMessageOpen(stored, false, true)).toBe(true);
	});

	it("closes the newest message on the first toggle", () => {
		const stored = toggle(undefined, true, true);
		expect(isMessageOpen(stored, true, true)).toBe(false);
	});

	it("round-trips: two toggles return to where it started", () => {
		const once = toggle(undefined, false, true);
		const twice = toggle(once, false, true);
		expect(isMessageOpen(twice, false, true)).toBe(false);
	});
});

describe("mark queue to tag operations", () => {
	it("turns an archive mark into removing inbox", () => {
		expect(markToOps({ "a@x": staged(["archive"]) })).toEqual([
			{ id: "a@x", add: [], remove: ["inbox"] },
		]);
	});

	it("turns a delete mark into deleted plus removing inbox", () => {
		const [op] = markToOps({ "a@x": staged(["delete"]) });
		expect(op!.add).toEqual(["deleted"]);
		expect(op!.remove).toEqual(["inbox"]);
	});

	it("batches several messages into one operation list", () => {
		const ops = markToOps({
			"a@x": staged(["archive"]),
			"b@x": staged(["flag"]),
		});
		expect(ops).toHaveLength(2);
		expect(ops.map((o) => o.id).sort()).toEqual(["a@x", "b@x"]);
	});

	it("merges several marks on the same message", () => {
		const [op] = markToOps({ "a@x": staged(["archive", "read"]) });
		expect(op!.remove.sort()).toEqual(["inbox", "unread"]);
	});

	it("never both adds and removes the same tag", () => {
		const [op] = markToOps({ "a@x": staged(["read", "unread"]) });
		expect(op!.add).toEqual(["unread"]);
		expect(op!.remove).not.toContain("unread");
	});

	it("drops messages whose marks cancel out to nothing", () => {
		expect(markToOps({ "a@x": staged([]) })).toEqual([]);
	});

	it("produces nothing for an empty queue", () => {
		expect(markToOps({})).toEqual([]);
	});
});

describe("mark badges", () => {
	it("gives every mark a single-character badge", () => {
		for (const [mark, spec] of Object.entries(MARK_TAGS)) {
			expect(spec.badge, mark).toHaveLength(1);
		}
	});
});

describe("default views", () => {
	it("every view has a non-empty notmuch query", () => {
		for (const view of DEFAULT_VIEWS) {
			expect(view.query.trim(), view.name).not.toBe("");
		}
	});

	it("inbox is first so it is the landing view", () => {
		expect(DEFAULT_VIEWS[0]!.name).toBe("Inbox");
		expect(DEFAULT_VIEWS[0]!.query).toBe("tag:inbox");
	});

	it("view names are unique", () => {
		const names = DEFAULT_VIEWS.map((v) => v.name);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe("staging arbitrary tags", () => {
	it("reads a bare word as an addition", () => {
		expect(parseTagInput("work")).toEqual({ add: ["work"], remove: [] });
	});

	it("reads + and - explicitly", () => {
		expect(parseTagInput("+work -inbox")).toEqual({
			add: ["work"],
			remove: ["inbox"],
		});
	});

	it("takes several tags at once", () => {
		expect(parseTagInput("a, b -c")).toEqual({
			add: ["a", "b"],
			remove: ["c"],
		});
	});

	it("ignores a bare sign", () => {
		expect(parseTagInput("- +")).toEqual({ add: [], remove: [] });
	});

	it("yields nothing for empty input", () => {
		expect(parseTagInput("   ")).toEqual({ add: [], remove: [] });
	});

	it("turns staged tags into one operation per message", () => {
		const ops = markToOps({ "a@x": staged([], ["work"], ["inbox"]) });
		expect(ops).toEqual([{ id: "a@x", add: ["work"], remove: ["inbox"] }]);
	});

	it("merges presets with typed tags", () => {
		const [op] = markToOps({ "a@x": staged(["delete"], ["spam"]) });
		expect(op!.add.sort()).toEqual(["deleted", "spam"]);
		expect(op!.remove).toEqual(["inbox"]);
	});
});

describe("what the margin tape shows", () => {
	it("is empty when nothing is staged", () => {
		expect(badgesFor(undefined)).toBe("");
		expect(badgesFor(staged([]))).toBe("");
	});

	it("shows one character per preset", () => {
		expect(badgesFor(staged(["archive", "flag"]))).toBe("AF");
	});

	it("marks typed tags with a T", () => {
		expect(badgesFor(staged([], ["work"]))).toBe("T");
		expect(badgesFor(staged(["delete"], [], ["inbox"]))).toBe("DT");
	});
});

describe("which tags the sidebar lists", () => {
	const accounts = [{ id: "iisc" }, { id: "personal" }, { id: "zenteiq" }];

	it("drops the account tags every message carries", () => {
		expect(
			tagsWithoutAccounts(["deleted", "iisc", "inbox", "personal"], accounts),
		).toEqual(["deleted", "inbox"]);
	});

	it("keeps everything else, including what a mailbox row also shows", () => {
		const tags = ["attachment", "flagged", "inbox", "sent", "unread"];
		expect(tagsWithoutAccounts(tags, accounts)).toEqual(tags);
	});

	it("hides nothing before the accounts have loaded", () => {
		expect(tagsWithoutAccounts(["iisc", "work"], [])).toEqual(["iisc", "work"]);
	});
});
