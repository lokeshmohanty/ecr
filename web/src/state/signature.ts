/**
 * Where an account's signature goes in a draft.
 *
 * Pure, and apart from the composer, because *where* is the whole question and
 * it is not the same answer for a blank message and a reply. A signature at the
 * very bottom of a reply sits under the quoted conversation, where nobody reads
 * it and every subsequent round of the thread carries another copy; it belongs
 * under what is being written, above the quote.
 */

/** RFC 3676's signature delimiter: dash dash space, on a line of its own. */
export const DELIMITER = "-- ";

/**
 * The body with the signature in it, or the body unchanged.
 *
 * The delimiter is written here rather than kept in the setting, so a reader
 * who does not know about `-- ` still gets a signature every client strips
 * from a reply — and one who *does* cannot end up with two.
 */
export function withSignature(body: string, signature: string): string {
	const text = signature.replace(/\s+$/, "");
	if (text === "") return body;

	const block = `${DELIMITER}\n${text}`;
	const quote = firstQuotedLine(body);

	// Nothing quoted: the signature is the end of the message.
	if (quote === -1) {
		const written = body.replace(/\n+$/, "");
		return written === "" ? `\n${block}\n` : `${written}\n\n${block}\n`;
	}

	// A reply: above the attribution line and the quote under it, with the
	// caret's blank lines left alone at the top.
	const before = body.slice(0, quote).replace(/\n+$/, "");
	return `${before}\n\n${block}\n\n${body.slice(quote)}`;
}

/**
 * Where the quoted part of a reply starts — the attribution line, not the
 * first `>`.
 *
 * The attribution ("On <date>, <who> wrote:") introduces the quote and belongs
 * with it. Splitting on the first `>` instead would leave that line stranded
 * above the signature, reading as though the reader wrote it.
 */
function firstQuotedLine(body: string): number {
	const lines = body.split("\n");
	let at = 0;
	for (const [index, line] of lines.entries()) {
		if (line.startsWith(">")) {
			// Walk back over the attribution and the blank line under it.
			const previous = lines[index - 1] ?? "";
			return previous.trim() !== "" && !previous.startsWith(">")
				? at - previous.length - 1
				: at;
		}
		at += line.length + 1;
	}
	return -1;
}

/**
 * The signature for an address, from the account that owns it.
 *
 * An alias may carry its own, and falls back to the account's — an address
 * that is a second hat for the same person usually wants the same sign-off,
 * and making every alias repeat it is how one of them ends up stale. The same
 * rule as `ManagedAccount::signature_for` in `ecr-core`, which is where it is
 * written down for anything that has to answer this server-side.
 */
export function signatureFor(
	address: string | undefined,
	accounts: {
		address: string;
		signature?: string;
		aliases?: { address: string; signature?: string }[];
	}[],
): string {
	if (!address) return "";

	for (const account of accounts) {
		if (account.address === address) return account.signature ?? "";

		const alias = account.aliases?.find((a) => a.address === address);
		if (alias) return alias.signature ?? account.signature ?? "";
	}
	return "";
}
