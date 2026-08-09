import type { ThreadSummary } from "../api/types";

/**
 * What a new-mail notification says.
 *
 * Kept apart from the store because the wording *is* the feature. A
 * notification is read in a glance, from a lock screen, by somebody who is
 * doing something else — so what goes in the title and what goes in the body
 * is the whole design, and it is the part worth pinning in a test.
 */
export interface Announcement {
	/** Who it is from. The first thing anybody reads. */
	title: string;
	/** What it is about. */
	body: string;
}

/**
 * The query notifications are drawn from.
 *
 * `tag:inbox and tag:unread`, and both halves matter. Without `inbox` a filing
 * rule that files something away still buzzes the phone, which is the opposite
 * of what a filing rule is for. Without `unread` a message read on another
 * device is announced here — a tag change is a database change like any other,
 * so the client is told about it, and "new mail" that has already been read is
 * how somebody learns to ignore notifications.
 */
export const NOTIFY_QUERY = "tag:inbox and tag:unread";

/** A sender's display name, or their address when there is no name. */
export function senderName(authors: string[]): string {
	const first = authors.find((author) => author.trim().length > 0);
	if (!first) return "Unknown sender";

	const trimmed = first.trim();
	// `Ada Lovelace <ada@example.com>` — the name is what a person recognises,
	// and an address is what they fall back to.
	const angled = trimmed.match(/^(.*?)\s*<([^>]+)>$/);
	if (angled) {
		const name = angled[1]!.replace(/^["']|["']$/g, "").trim();
		return name || angled[2]!.trim();
	}
	return trimmed;
}

/**
 * Turns the threads that have just arrived into one notification.
 *
 * One notification for a batch, never one each: mail arrives in bursts — a
 * sync after a laptop wakes delivers everything at once — and a notification
 * per message is a phone that buzzes forty times and gets muted.
 *
 * Answers null when there is nothing to say, so the caller never has to decide
 * whether an empty list is worth announcing.
 */
export function announcementFor(arrived: ThreadSummary[]): Announcement | null {
	if (arrived.length === 0) return null;

	// Newest first, so the one named is the one that just landed.
	const sorted = [...arrived].sort((a, b) => b.timestamp - a.timestamp);
	const newest = sorted[0]!;
	const subject = newest.subject.trim() || "(no subject)";

	if (sorted.length === 1) {
		return { title: senderName(newest.authors), body: subject };
	}

	// The rest are counted rather than listed. A notification that tries to
	// name five senders is one nobody finishes reading, and the count is the
	// thing that decides whether to go and look.
	const others = sorted.length - 1;
	return {
		title: `${senderName(newest.authors)} and ${others} other${others === 1 ? "" : "s"}`,
		body: subject,
	};
}

/**
 * Which of the current threads are new since the last time we looked.
 *
 * `since` is a timestamp rather than a set of ids, because the list this is
 * compared against is only ever the newest page: a thread that falls off the
 * end of it would look new again the moment it came back, and a set would grow
 * without bound to prevent that.
 *
 * A thread exactly *at* `since` is not new. Two messages can share a second,
 * and announcing the same one twice is worse than missing a simultaneous
 * arrival that the next event will carry anyway.
 */
export function arrivedSince(
	threads: ThreadSummary[],
	since: number,
): ThreadSummary[] {
	return threads.filter((thread) => thread.timestamp > since);
}

/** The high-water mark to remember, given what is on screen now. */
export function newestTimestamp(threads: ThreadSummary[], fallback = 0): number {
	return threads.reduce((max, thread) => Math.max(max, thread.timestamp), fallback);
}
