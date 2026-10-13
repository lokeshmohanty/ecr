import { describe, expect, it } from "vitest";
import type { Address, Message } from "../api/types";
import { forwardDraft, replyDraft } from "./reply";

function address(email: string, name: string | null = null): Address {
	return { name, email };
}

function message(overrides: Partial<Message> = {}): Message {
	return {
		id: "m1@example.com",
		thread_id: "t1",
		subject: "Hello",
		from: [address("alice@example.com", "Alice")],
		to: [address("me@example.com", "Me")],
		cc: [],
		bcc: [],
		reply_to: [],
		date: "2026-04-01T10:00:00Z",
		timestamp: 0,
		tags: [],
		in_reply_to: null,
		references: [],
		parts: [],
		excluded: false,
		...overrides,
	};
}

const ME = ["me@example.com"];

describe("a reply", () => {
	it("goes to the sender and nobody else", () => {
		const draft = replyDraft(
			message({
				to: [address("me@example.com"), address("carol@example.com")],
				cc: [address("dave@example.com")],
			}),
			false,
			"body",
			ME,
		);

		expect(draft.to).toEqual(["alice@example.com"]);
		expect(draft.cc).toEqual([]);
	});

	it("honours the Reply-To header", () => {
		const draft = replyDraft(
			message({ reply_to: [address("list@example.com")] }),
			false,
			"body",
			ME,
		);

		expect(draft.to).toEqual(["list@example.com"]);
	});

	it("threads through the message", () => {
		const original = message({ references: ["root@example.com"] });
		const draft = replyDraft(original, false, "body", ME);

		expect(draft.in_reply_to).toBe(original.id);
		expect(draft.references).toEqual(["root@example.com", original.id]);
	});

	it("does not stack another Re:", () => {
		const draft = replyDraft(message({ subject: "Re: Hello" }), false, "", ME);

		expect(draft.subject).toBe("Re: Hello");
	});
});

describe("a reply all", () => {
	it("ccs everyone the message reached", () => {
		const draft = replyDraft(
			message({
				to: [address("me@example.com"), address("carol@example.com")],
				cc: [address("dave@example.com")],
			}),
			true,
			"body",
			ME,
		);

		expect(draft.to).toEqual(["alice@example.com"]);
		expect(draft.cc).toEqual(["carol@example.com", "dave@example.com"]);
	});

	it("never ccs the reader, including an alias", () => {
		const draft = replyDraft(
			message({
				to: [address("me@example.com")],
				cc: [address("work@example.com"), address("dave@example.com")],
			}),
			true,
			"body",
			["me@example.com", "work@example.com"],
		);

		expect(draft.cc).toEqual(["dave@example.com"]);
	});

	it("does not cc someone already in To", () => {
		const draft = replyDraft(
			message({
				reply_to: [address("alice@example.com")],
				to: [address("alice@example.com"), address("carol@example.com")],
			}),
			true,
			"body",
			ME,
		);

		expect(draft.to).toEqual(["alice@example.com"]);
		expect(draft.cc).toEqual(["carol@example.com"]);
	});

	it("does not repeat an address listed twice", () => {
		const draft = replyDraft(
			message({
				to: [address("carol@example.com")],
				cc: [address("carol@example.com")],
			}),
			true,
			"body",
			ME,
		);

		expect(draft.cc).toEqual(["carol@example.com"]);
	});
});

describe("a forward", () => {
	it("starts with no recipients and quotes the original", () => {
		const draft = forwardDraft(message(), "hello");

		expect(draft.to).toEqual([]);
		expect(draft.cc).toEqual([]);
		expect(draft.subject).toBe("Fwd: Hello");
		expect(draft.body).toContain("hello");
		expect(draft.in_reply_to).toBeNull();
	});
});
