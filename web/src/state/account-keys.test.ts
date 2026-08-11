import { describe, expect, it } from "vitest";
import type { Account } from "../api/types";
import { accountKeys } from "./account-keys";
import { ALL_ACCOUNTS } from "./views";

const account = (id: string, address?: string): Account => ({
	id,
	display_name: id,
	maildir_path: `/mail/${id}`,
	address: address ?? null,
	mbsync_channel: id,
	msmtp_account: id,
	folders: [],
});

describe("accountKeys", () => {
	it("takes the first letter of each name", () => {
		const rows = accountKeys([
			account("iisc"),
			account("main"),
			account("personal"),
			account("zenteiq"),
		]);

		expect(rows.map((r) => r.key)).toEqual(["0", "i", "m", "p", "z"]);
		expect(rows[0]!.id).toBe(ALL_ACCOUNTS);
	});

	/**
	 * The case the design is for. A second `m` account must not take the letter
	 * the first one has — the reader learned it from a menu that was right at
	 * the time, and a key that quietly moves is worse than one that was never
	 * mnemonic.
	 */
	it("gives a colliding name the next unused letter of its own", () => {
		const rows = accountKeys([account("main"), account("mail")]);

		expect(rows[1]!.key).toBe("m");
		expect(rows[2]!.key).toBe("a");
	});

	it("falls through the alphabet when a name has nothing left", () => {
		const rows = accountKeys([account("aa"), account("aa2"), account("a")]);
		const keys = rows.map((r) => r.key);

		expect(new Set(keys).size).toBe(keys.length);
	});

	/** All accounts is not one of them, so it never eats a letter. */
	it("reserves 0 for all accounts", () => {
		const rows = accountKeys([account("zero")]);
		expect(rows[0]!.key).toBe("0");
		expect(rows[1]!.key).toBe("z");
	});

	it("carries the address for the row to show", () => {
		const rows = accountKeys([account("main", "a@b.c")]);
		expect(rows[1]!.address).toBe("a@b.c");
	});
});
