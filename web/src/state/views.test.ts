import { describe, expect, it } from "vitest";
import {
	ALL_ACCOUNTS,
	VIEW_TEMPLATES,
	accountLabel,
	buildTree,
	scopeQuery,
	viewQuery,
} from "./views";

const ACCOUNTS = [
	{ id: "work", address: "alice@example.org" },
	{ id: "main", address: "alice@example.com" },
	{ id: "personal", address: "alice.personal@example.com" },
];

describe("scoping a query to an account", () => {
	it("ands the account tag onto a view query", () => {
		expect(scopeQuery("tag:inbox", "main")).toBe("(tag:inbox) and (tag:main)");
	});

	it("leaves a query alone for the all-accounts scope", () => {
		expect(scopeQuery("tag:inbox", ALL_ACCOUNTS)).toBe("tag:inbox");
	});

	it("scopes a match-all query to just the account", () => {
		expect(scopeQuery("*", "main")).toBe("tag:main");
	});

	it("keeps a compound query intact by parenthesising it", () => {
		expect(scopeQuery("not tag:inbox and not tag:trash", "work")).toBe(
			"(not tag:inbox and not tag:trash) and (tag:work)",
		);
	});
});

describe("view queries", () => {
	it("resolves a template against an account", () => {
		expect(viewQuery("Unread", "main")).toBe("(tag:unread) and (tag:main)");
	});

	it("resolves a template for all accounts", () => {
		expect(viewQuery("Unread", ALL_ACCOUNTS)).toBe("tag:unread");
	});

	it("returns null for an unknown view", () => {
		expect(viewQuery("NOPE", "main")).toBeNull();
	});

	it("every template has a non-empty query", () => {
		for (const view of VIEW_TEMPLATES) {
			expect(view.query.trim(), view.name).not.toBe("");
		}
	});

	it("template names are unique", () => {
		const names = VIEW_TEMPLATES.map((v) => v.name);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe("the sidebar tree", () => {
	it("puts All first, then one group per account", () => {
		const tree = buildTree(ACCOUNTS);
		expect(tree[0]!.account).toBe(ALL_ACCOUNTS);
		expect(tree.slice(1).map((g) => g.account)).toEqual([
			"work",
			"main",
			"personal",
		]);
	});

	it("gives every account the full set of views", () => {
		for (const group of buildTree(ACCOUNTS)) {
			expect(group.views.map((v) => v.name)).toEqual(
				VIEW_TEMPLATES.map((v) => v.name),
			);
		}
	});

	it("scopes each account's views to that account", () => {
		const main = buildTree(ACCOUNTS).find((g) => g.account === "main")!;
		const inbox = main.views.find((v) => v.name === "Inbox")!;
		expect(inbox.query).toBe("(tag:inbox) and (tag:main)");
	});

	it("leaves the All group unscoped", () => {
		const all = buildTree(ACCOUNTS)[0]!;
		expect(all.views.find((v) => v.name === "Inbox")!.query).toBe("tag:inbox");
	});

	it("still produces the All group when there are no accounts", () => {
		const tree = buildTree([]);
		expect(tree).toHaveLength(1);
		expect(tree[0]!.account).toBe(ALL_ACCOUNTS);
	});

	it("carries each account's address for display", () => {
		const main = buildTree(ACCOUNTS).find((g) => g.account === "main")!;
		expect(main.address).toBe("alice@example.com");
	});
});

describe("which account a query belongs to", () => {
	it("recognises a scoped query", () => {
		expect(accountLabel("(tag:inbox) and (tag:main)", ACCOUNTS)).toBe("main");
	});

	it("recognises a bare account query", () => {
		expect(accountLabel("tag:work", ACCOUNTS)).toBe("work");
	});

	it("reports all accounts for an unscoped query", () => {
		expect(accountLabel("tag:inbox", ACCOUNTS)).toBe(ALL_ACCOUNTS);
	});

	it("does not mistake a folder path for an account tag", () => {
		expect(accountLabel('path:"main/Inbox/**"', ACCOUNTS)).toBe("main");
	});

	it("does not match an account name appearing inside another word", () => {
		expect(accountLabel("tag:mainframe", ACCOUNTS)).toBe(ALL_ACCOUNTS);
	});
});

describe("the sent view", () => {
	it("matches what you sent, not what a hook happened to tag", () => {
		const main = buildTree(ACCOUNTS).find((g) => g.account === "main")!;
		expect(main.views.find((v) => v.name === "Sent")!.query).toBe(
			"from:alice@example.com",
		);
	});

	it("combines every address for the all-accounts group", () => {
		const all = buildTree(ACCOUNTS)[0]!;
		expect(all.views.find((v) => v.name === "Sent")!.query).toBe(
			"from:alice@example.org or from:alice@example.com or from:alice.personal@example.com",
		);
	});

	it("falls back to the tag when an account has no address", () => {
		const tree = buildTree([{ id: "orphan" }]);
		const orphan = tree.find((g) => g.account === "orphan")!;
		expect(orphan.views.find((v) => v.name === "Sent")!.query).toBe(
			"(tag:sent) and (tag:orphan)",
		);
	});

	it("falls back for all-accounts when no address is known", () => {
		const all = buildTree([{ id: "orphan" }])[0]!;
		expect(all.views.find((v) => v.name === "Sent")!.query).toBe("tag:sent");
	});

	it("leaves the other views alone", () => {
		const main = buildTree(ACCOUNTS).find((g) => g.account === "main")!;
		expect(main.views.find((v) => v.name === "Inbox")!.query).toBe(
			"(tag:inbox) and (tag:main)",
		);
	});
});
