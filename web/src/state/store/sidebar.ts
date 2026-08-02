/**
 * The sidebar's row shape and the pure rules around it. Building the rows needs
 * the store's signals and stays there; this is what can be reasoned about
 * without them.
 */
import type { SectionId } from "../views";

/**
 * The post-new hook tags every message with its account, so a row per account
 * tag under Tags would only repeat the account groups above it — and match the
 * whole account. Which tags those are is whatever is configured; nothing else
 * is hidden.
 */
export function tagsWithoutAccounts(
	tags: string[],
	accounts: { id: string }[],
): string[] {
	const own = new Set(accounts.map((a) => a.id));
	return tags.filter((tag) => !own.has(tag));
}

export interface SidebarRow {
	kind: "group" | "view" | "section";
	name: string;
	group: string;
	query: string;
	icon: string;
	/** Nesting depth, since the list itself is flat for j/k. */
	indent: number;
	/** Whether a count means anything for this row. */
	counted: boolean;
	section?: SectionId;
}

export function sectionKey(group: string, section: SectionId): string {
	return `${group}:${section}`;
}

/**
 * notmuch splits an unquoted term on punctuation, so a tag or address with a
 * dot or a slash in it would match far more than itself.
 */
export function quoteTerm(value: string): string {
	return /^[\w@-]+$/.test(value) ? value : `"${value.replace(/"/g, "")}"`;
}

/**
 * First letter of each word, for the sidebar label only. Account ids and view
 * names are config elsewhere; this is a display transform, never written back.
 */
export function titleCase(value: string): string {
	return value.replace(/\b\w/g, (c) => c.toUpperCase());
}
