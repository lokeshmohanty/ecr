import type { Account } from "../api/types";
import { ALL_ACCOUNTS } from "./views";

/** One account and the key that reaches it. */
export interface AccountKey {
	/** The account id, or `ALL_ACCOUNTS`. */
	id: string;
	/** What the row says. */
	label: string;
	/** The address, when the account has one. */
	address?: string;
	/** The single character that picks this row. */
	key: string;
}

/**
 * Which key goes to which account.
 *
 * The first letter of the name, because a mnemonic is the only reason to
 * prefer this over a number: `m` for main is remembered, position three is
 * looked up. All accounts is `0` — it is not one of them, and giving it a
 * letter would mean the letters no longer line up with the names.
 *
 * **Two accounts starting alike is the case that decides the design.** The
 * second one falls through to the next unused letter of its own name, then to
 * the alphabet, and only then to a digit; what it must never do is take a
 * letter another account already holds, because the reader learned that letter
 * from a menu that was correct at the time. Order therefore decides ties, and
 * order is the sidebar's — the same list, in the same order, both places.
 */
export function accountKeys(accounts: Account[]): AccountKey[] {
	const taken = new Set(["0"]);
	const rows: AccountKey[] = [
		{ id: ALL_ACCOUNTS, label: "all accounts", key: "0" },
	];

	for (const account of accounts) {
		const name = account.id;
		const candidates = [
			...name.toLowerCase(),
			...ALPHABET,
			...DIGITS,
		].filter((c) => /[a-z0-9]/.test(c));

		const key = candidates.find((c) => !taken.has(c));
		// Nothing is left only when there are more than 36 accounts, and a row
		// nobody can press is still a row that says the account exists.
		if (key) taken.add(key);

		rows.push({
			id: name,
			label: name,
			address: account.address ?? undefined,
			key: key ?? "",
		});
	}

	return rows;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "123456789";
