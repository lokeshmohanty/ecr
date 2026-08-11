import { describe, expect, it } from "vitest";
import type { ManagedAccount } from "../../../api/types";
import { accountFrom, hostPort, shown, type Draft } from "./draft";

const draft: Draft = {
	address: "alice@gmail.com",
	name: "Alice",
	provider: "gmail",
	imap: "",
	smtp: "",
	signature: "",
	primary: true,
	enabled: true,
};

const existing: ManagedAccount = {
	address: "alice@gmail.com",
	provider: "gmail",
	auth: { kind: "oauth", profile: "main" },
	folders: { archive: "[Gmail]/All Mail", trash: "[Gmail]/Bin" },
	patterns: ["*"],
	create: "near",
	expunge: "both",
	remove: "both",
	certificate_file: "/etc/ssl/certs/ca-certificates.crt",
	aliases: [{ address: "alias@gmail.com" }],
	primary: true,
	enabled: true,
};

describe("accountFrom", () => {
	/**
	 * The update route replaces the account rather than patching it. Everything
	 * the form does not show has to survive the round trip, or editing an address
	 * quietly rewrites how far a deletion travels and which folders exist.
	 */
	it("carries across every field the form never showed", () => {
		const saved = accountFrom({ ...draft, name: "Alice B" }, "main", existing);

		expect(saved.expunge).toBe("both");
		expect(saved.remove).toBe("both");
		expect(saved.patterns).toEqual(["*"]);
		expect(saved.folders).toEqual({
			archive: "[Gmail]/All Mail",
			trash: "[Gmail]/Bin",
		});
		expect(saved.certificate_file).toBe(
			"/etc/ssl/certs/ca-certificates.crt",
		);
		expect(saved.aliases).toEqual([{ address: "alias@gmail.com" }]);
		expect(saved.name).toBe("Alice B");
	});

	/**
	 * A password command is set at a terminal, because it is a command the server
	 * would run. An unrelated edit must not convert it to OAuth.
	 */
	it("keeps a password command rather than converting it to oauth", () => {
		const withCommand: ManagedAccount = {
			...existing,
			auth: { kind: "command", command: ["pass", "show", "mail"] },
		};

		expect(accountFrom(draft, "main", withCommand).auth).toEqual({
			kind: "command",
			command: ["pass", "show", "mail"],
		});
	});

	/**
	 * A managed default that deletes is a managed default that is wrong: ecr
	 * fetches a folder that appears on the server and never removes or expunges
	 * anything on it unless somebody said so.
	 */
	it("gives a new account defaults that never propagate a deletion", () => {
		const fresh = accountFrom(draft, "personal");

		expect(fresh.expunge).toBe("none");
		expect(fresh.remove).toBe("none");
		expect(fresh.create).toBe("near");
		expect(fresh.auth).toEqual({ kind: "oauth", profile: "personal" });
	});

	it("only takes the typed servers for a generic provider", () => {
		const generic = accountFrom(
			{ ...draft, provider: "generic", imap: "imap.example.com", smtp: "smtp.example.com" },
			"work",
		);

		expect(generic.imap).toEqual({
			host: "imap.example.com",
			port: 993,
			tls: "implicit",
		});
		expect(generic.smtp).toEqual({
			host: "smtp.example.com",
			port: 587,
			tls: "starttls",
		});

		// A preset provider keeps whatever it had; the fields are not even shown.
		expect(accountFrom(draft, "main", existing).imap).toBeUndefined();
	});
});

describe("hostPort", () => {
	it("takes an explicit port over the default", () => {
		expect(hostPort("mail.example.com:1993", 993)?.port).toBe(1993);
		expect(hostPort("mail.example.com", 993)?.port).toBe(993);
	});

	it("is nothing at all when there is no host", () => {
		expect(hostPort("", 993)).toBeUndefined();
	});

	it("round-trips through what the form shows", () => {
		expect(shown(hostPort("mail.example.com:1993", 993))).toBe(
			"mail.example.com:1993",
		);
		expect(shown(undefined)).toBe("");
	});
});

describe("the signature", () => {
	/**
	 * Absent, not empty. The field is optional in accounts.toml, and an empty
	 * string would put a bare `-- ` under every message from an account whose
	 * signature had been cleared.
	 */
	it("is dropped rather than written blank", () => {
		expect(accountFrom({ ...draft, signature: "  " }, "main").signature).toBeUndefined();
	});

	it("is carried through when there is one", () => {
		expect(accountFrom({ ...draft, signature: "Ada\nEngines" }, "main").signature).toBe(
			"Ada\nEngines",
		);
	});

	/** An edit that does not touch the signature must not clear it. */
	it("replaces what the account had", () => {
		const saved = accountFrom({ ...draft, signature: "new" }, "main", {
			...existing,
			signature: "old",
		});
		expect(saved.signature).toBe("new");
	});
});
