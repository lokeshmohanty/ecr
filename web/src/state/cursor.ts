/**
 * Where the cursor goes when the list under it changes.
 *
 * The cursor is an index, and a list that loses rows keeps its indices — so
 * archiving four threads left it pointing four rows further down than the mail
 * it was on. The list scrolls, the cursor does not go with it, and what is
 * under it afterwards is whatever happened to fall into that slot. Which is
 * the worst possible answer: the next key acts on a thread nobody chose.
 *
 * What a reader means by "where I was" is the *thread*, so that is what is
 * followed. When the thread itself is one of the ones that went, the answer is
 * the next one that survived — reading down a mailbox and clearing it as you
 * go should leave the cursor on the next thing to read, not somewhere below it
 * by however many rows were removed above.
 *
 * `previous` is the order the list was in when the cursor was last placed, and
 * it is the reason a row removed *above* the cursor is handled too: an index
 * alone cannot tell that case from a row removed below.
 */
export function followCursor(
	previous: string[],
	index: number,
	next: { id: string }[],
): number {
	if (next.length === 0) return 0;

	const last = next.length - 1;
	const clamped = Math.min(Math.max(index, 0), last);

	// Nothing to follow: a fresh query, or the first page there has ever been.
	if (previous.length === 0) return clamped;

	const at = new Map(next.map((row, position) => [row.id, position]));

	// The row the cursor was on, then the first one after it that is still here.
	for (let i = Math.max(index, 0); i < previous.length; i += 1) {
		const found = at.get(previous[i]!);
		if (found !== undefined) return found;
	}

	// Everything from the cursor down has gone, so the end of the list is the
	// nearest thing to where it was.
	for (let i = Math.min(index, previous.length) - 1; i >= 0; i -= 1) {
		const found = at.get(previous[i]!);
		if (found !== undefined) return found;
	}

	return clamped;
}
