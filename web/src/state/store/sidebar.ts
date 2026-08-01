/**
 * The sidebar's row shape and the pure rules around it. Building the rows needs
 * the store's signals and stays there; this is what can be reasoned about
 * without them.
 */
import type { SectionId } from "../views";

/**
 * Tags every message carries, or that a mailbox row already stands for. Listing
 * them under Tags would be a column of noise the width of the sidebar.
 */
export const HIDDEN_TAGS = new Set([
  "inbox",
  "unread",
  "flagged",
  "draft",
  "sent",
  "replied",
  "passed",
  "attachment",
  "signed",
  "encrypted",
  "new",
]);

/** Enough correspondents to be useful, few enough to stay scannable. */
export const PEOPLE_SHOWN = 15;

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
