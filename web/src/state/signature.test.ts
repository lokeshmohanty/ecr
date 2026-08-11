import { describe, expect, it } from "vitest";
import { signatureFor, withSignature } from "./signature";

describe("withSignature", () => {
	it("leaves a body alone when there is no signature", () => {
		expect(withSignature("hello", "")).toBe("hello");
		expect(withSignature("hello", "   \n ")).toBe("hello");
	});

	it("writes the delimiter, so the setting does not have to", () => {
		expect(withSignature("hello", "Ada")).toBe("hello\n\n-- \nAda\n");
	});

	it("puts a signature into an empty draft", () => {
		expect(withSignature("", "Ada")).toBe("\n-- \nAda\n");
	});

	/**
	 * The reason this is a module and not a `+=`. Under the quote it is where
	 * nobody reads it, and every further round of the thread carries another
	 * copy of it down the page.
	 */
	it("goes above the quoted conversation in a reply", () => {
		const reply = "\n\nOn Tuesday, ada@example.com wrote:\n> hello\n> there\n";
		const out = withSignature(reply, "Ada");

		expect(out).toBe(
			"\n\n-- \nAda\n\nOn Tuesday, ada@example.com wrote:\n> hello\n> there\n",
		);
		expect(out.indexOf("-- ")).toBeLessThan(out.indexOf("On Tuesday"));
	});

	/** The attribution introduces the quote and travels with it. */
	it("keeps the attribution line with the quote it introduces", () => {
		const out = withSignature(
			"\n\nOn Tuesday, ada wrote:\n> hello\n",
			"Grace",
		);
		expect(out).toContain("-- \nGrace\n\nOn Tuesday");
	});

	it("does not need an attribution to find the quote", () => {
		expect(withSignature("thoughts?\n\n> hello\n", "Ada")).toBe(
			"thoughts?\n\n-- \nAda\n\n> hello\n",
		);
	});
});

describe("signatureFor", () => {
	const accounts = [
		{
			address: "ada@example.com",
			signature: "Ada Lovelace",
			aliases: [
				{ address: "ada@work.example", signature: "Ada, at work" },
				{ address: "a.l@example.com" },
			],
		},
		{ address: "grace@example.org" },
	];

	it("finds an account's own", () => {
		expect(signatureFor("ada@example.com", accounts)).toBe("Ada Lovelace");
	});

	it("prefers an alias's own", () => {
		expect(signatureFor("ada@work.example", accounts)).toBe("Ada, at work");
	});

	/** A second hat for the same person usually wants the same sign-off. */
	it("falls back to the account's for an alias without one", () => {
		expect(signatureFor("a.l@example.com", accounts)).toBe("Ada Lovelace");
	});

	it("answers empty for an account with none, and for a stranger", () => {
		expect(signatureFor("grace@example.org", accounts)).toBe("");
		expect(signatureFor("nobody@example.net", accounts)).toBe("");
		expect(signatureFor(undefined, accounts)).toBe("");
	});
});
