/**
 * Staging: what is queued against a message, and how that queue becomes tag
 * operations. Pure — the list stages here and `x` writes it, but nothing in
 * this file knows about either.
 */
export type Mark = "archive" | "delete" | "read" | "unread" | "flag";

export interface Staged {
	marks: Mark[];
	add: string[];
	remove: string[];
}

export interface MarkQueue {
	[messageId: string]: Staged;
}

export function emptyStaged(): Staged {
	return { marks: [], add: [], remove: [] };
}

/** `+work`, `-inbox`, or a bare tag meaning add. */
export function parseTagInput(input: string): {
	add: string[];
	remove: string[];
} {
	const add: string[] = [];
	const remove: string[] = [];

	for (const word of input.split(/[\s,]+/).filter(Boolean)) {
		if (word.startsWith("-")) {
			if (word.length > 1) remove.push(word.slice(1));
		} else {
			const tag = word.startsWith("+") ? word.slice(1) : word;
			if (tag) add.push(tag);
		}
	}
	return { add, remove };
}

export function badgesFor(staged: Staged | undefined): string {
	if (!staged) return "";
	const presets = staged.marks.map((m) => MARK_TAGS[m].badge).join("");
	const tagged = staged.add.length > 0 || staged.remove.length > 0 ? "T" : "";
	return presets + tagged;
}

/** What the right-hand pane is showing. */

export const MARK_TAGS: Record<
	Mark,
	{ add: string[]; remove: string[]; badge: string }
> = {
	archive: { add: [], remove: ["inbox"], badge: "A" },
	delete: { add: ["deleted"], remove: ["inbox"], badge: "D" },
	read: { add: [], remove: ["unread"], badge: "R" },
	unread: { add: ["unread"], remove: [], badge: "U" },
	flag: { add: ["flagged"], remove: [], badge: "F" },
};

export function markToOps(queue: MarkQueue) {
	return Object.entries(queue)
		.map(([id, staged]) => {
			const add = new Set<string>(staged.add);
			const remove = new Set<string>(staged.remove);
			for (const mark of staged.marks) {
				for (const tag of MARK_TAGS[mark].add) add.add(tag);
				for (const tag of MARK_TAGS[mark].remove) remove.add(tag);
			}
			// Adding a tag wins over removing it, so `u` after `r` reads as unread.
			for (const tag of add) remove.delete(tag);
			return { id, add: [...add], remove: [...remove] };
		})
		.filter((op) => op.add.length > 0 || op.remove.length > 0);
}

/**
 * Whether a message is showing, given any explicit fold and the default for
 * its position. The fold key has to agree with this: flipping the stored
 * boolean turned an absent entry into `true`, which reads as collapsed, so
 * `za` on an already-collapsed message did nothing at all.
 */
