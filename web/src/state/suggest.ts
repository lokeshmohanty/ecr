export interface Suggestion {
	/** The full query with the last term completed. */
	value: string;
	/** What the user sees as the completion itself. */
	label: string;
	detail: string;
}

export interface AddressEntry {
	name: string | null;
	email: string;
}

const MAX_QUERY_SUGGESTIONS = 12;
const MAX_ADDRESS_SUGGESTIONS = 8;

/** notmuch's search prefixes, with what each one narrows on. */
const PREFIXES: { prefix: string; detail: string }[] = [
	{ prefix: "tag:", detail: "messages carrying a tag" },
	{ prefix: "from:", detail: "sender address or name" },
	{ prefix: "to:", detail: "recipient address" },
	{ prefix: "subject:", detail: "words in the subject" },
	{ prefix: "attachment:", detail: "attachment filename" },
	{ prefix: "date:", detail: "date range, e.g. date:7d.." },
	{ prefix: "folder:", detail: "maildir folder" },
	{ prefix: "path:", detail: "maildir path, supports **" },
	{ prefix: "is:", detail: "synonym for tag:" },
	{ prefix: "thread:", detail: "a specific thread id" },
	{ prefix: "id:", detail: "a specific message id" },
	{ prefix: "mimetype:", detail: "part content type" },
];

/** Splits off the term being typed so earlier terms are preserved verbatim. */
function lastTerm(query: string): { head: string; term: string } {
	const match = /(^|\s(?:and|or|not)\s|\s)([^\s]*)$/i.exec(query);
	if (!match) return { head: "", term: query };

	const term = match[2] ?? "";
	return { head: query.slice(0, query.length - term.length), term };
}

export function suggestQuery(query: string, tags: string[]): Suggestion[] {
	if (query.trim() === "") return [];

	const { head, term } = lastTerm(query);
	const lower = term.toLowerCase();
	const out: Suggestion[] = [];

	const push = (completion: string, detail: string) => {
		out.push({ value: `${head}${completion}`, label: completion, detail });
	};

	// Completing a value after a known prefix.
	const withPrefix = /^(tag|is|from|to|folder|path):(.*)$/i.exec(term);
	if (withPrefix) {
		const prefix = withPrefix[1]!.toLowerCase();
		const fragment = (withPrefix[2] ?? "").toLowerCase();

		if (prefix === "tag" || prefix === "is") {
			for (const tag of tags) {
				if (tag.toLowerCase().startsWith(fragment))
					push(`${prefix}:${tag}`, "tag");
				if (out.length >= MAX_QUERY_SUGGESTIONS) return out;
			}
			return out;
		}
	}

	// Completing the prefix itself.
	for (const { prefix, detail } of PREFIXES) {
		if (prefix.startsWith(lower) && prefix !== lower) {
			push(prefix, detail);
			if (out.length >= MAX_QUERY_SUGGESTIONS) return out;
		}
	}

	// A bare word most often means a tag.
	if (!term.includes(":")) {
		for (const tag of tags) {
			if (tag.toLowerCase().startsWith(lower)) {
				push(`tag:${tag}`, "tag");
				if (out.length >= MAX_QUERY_SUGGESTIONS) return out;
			}
		}
	}

	return out.slice(0, MAX_QUERY_SUGGESTIONS);
}

export function parseAddress(raw: string): AddressEntry | null {
	const value = raw.trim();
	if (value === "") return null;

	const angled = /^(.*?)<([^>]+)>\s*$/.exec(value);
	if (angled) {
		const name = angled[1]!.trim().replace(/^"|"$/g, "").trim();
		const email = angled[2]!.trim();
		return email.includes("@") ? { name: name || null, email } : null;
	}

	return value.includes("@") && !/\s/.test(value)
		? { name: null, email: value }
		: null;
}

export function rankAddresses(
	book: AddressEntry[],
	fragment: string,
): AddressEntry[] {
	const needle = fragment.trim().toLowerCase();
	if (needle === "") return book.slice(0, MAX_ADDRESS_SUGGESTIONS * 100);

	const scored: { entry: AddressEntry; score: number }[] = [];

	for (const entry of book) {
		const email = entry.email.toLowerCase();
		const name = (entry.name ?? "").toLowerCase();

		let score = -1;
		if (email.startsWith(needle)) score = 0;
		else if (name.startsWith(needle)) score = 1;
		else if (name.split(/\s+/).some((w) => w.startsWith(needle))) score = 2;
		else if (email.includes(needle)) score = 3;
		else if (name.includes(needle)) score = 4;

		if (score >= 0) scored.push({ entry, score });
	}

	scored.sort(
		(a, b) => a.score - b.score || a.entry.email.localeCompare(b.entry.email),
	);
	return scored.slice(0, MAX_ADDRESS_SUGGESTIONS).map((s) => s.entry);
}

export interface RecipientFragment {
	/** The term being typed, after the last comma and trimmed. */
	fragment: string;
	/** Index in the text where the fragment starts. */
	start: number;
}

/**
 * The recipient being typed, if any: whatever follows the last comma before
 * the caret. The composer's header fields are DOM labels, so the buffer holds
 * a bare list — `alice@x.com, bo` — with no `to:` prefix to find.
 */
export function recipientFragment(
	text: string,
	caret: number,
): RecipientFragment | null {
	const before = text.slice(0, caret);
	const from = before.lastIndexOf(",") + 1;
	const raw = before.slice(from);
	const leading = raw.length - raw.trimStart().length;
	return { fragment: raw.trim(), start: from + leading };
}

/** Substitutes the chosen address for the fragment and leaves a trailing comma. */
export function completeRecipient(
	text: string,
	start: number,
	end: number,
	address: string,
): { text: string; caret: number } {
	const next = `${text.slice(0, start)}${address}, ${text.slice(end)}`;
	return { text: next, caret: start + address.length + 2 };
}
