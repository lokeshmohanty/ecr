/**
 * What an option *is*: its type, its default, and the prose that explains it in
 * the generated file. Nothing here knows about TOML or about storage.
 */
import { DEFAULT_BINDINGS, type Binding } from "../../keymap/engine";
import { type DateFormat } from "../datetime";
import { SECTION_IDS, type CustomView, type SectionId } from "../views";
import { DEFAULT_PACKAGES, type PackageSettings } from "../packages";

export interface Preferences {
  /** Rows fetched per query. */
  pageSize: number;
  /** Show HTML bodies rather than the plain-text alternative. */
  preferHtml: boolean;
  /** Load remote images without asking. */
  loadRemoteImages: boolean;
  /** Open the newest message expanded when a thread is opened. */
  expandNewest: boolean;
  /** Reply to everyone by default. */
  replyAll: boolean;
  /** Query the client starts on. */
  startQuery: string;
  /** Moving through a list updates the detail pane as you go. */
  followSelection: boolean;
  /** Which vim mode the composer and settings editor open in. */
  editorStartMode: "normal" | "insert";
  /** Open compose pinned to the bottom of the detail pane. */
  pinnedCompose: boolean;
  /** Drop the unread tag once a message has actually been on screen. */
  markReadOnOpen: boolean;
  /** How long it must be on screen first, in milliseconds. */
  markReadDelay: number;
  /** The theme file to load, relative to this file's directory. */
  theme: string;
  /** How dates are written in the message list. */
  listDateFormat: DateFormat;
  /** IANA timezone every date is shown in. Empty means the machine's own. */
  timezone: string;
  /** Show a glyph before each sidebar entry. */
  sidebarIcons: boolean;
  /** Draw a dotted leader from each sidebar label to its count. */
  sidebarLeaders: boolean;
  /** Fetch and show message counts in the sidebar. */
  sidebarCounts: boolean;
  /** Which sidebar sections appear, in order. */
  sidebarSections: SectionId[];
  /** Extra sidebar rows the user defined, appended after the sections. */
  sidebarCustom: CustomView[];
}

export const DEFAULT_PREFERENCES: Preferences = {
  pageSize: 100,
  preferHtml: true,
  loadRemoteImages: false,
  expandNewest: true,
  replyAll: false,
  startQuery: "tag:inbox",
  followSelection: true,
  editorStartMode: "normal",
  pinnedCompose: true,
  markReadOnOpen: true,
  markReadDelay: 1200,
  theme: "themes/ecr-dark.toml",
  listDateFormat: "adaptive",
  timezone: "Asia/Kolkata",
  sidebarIcons: true,
  sidebarLeaders: true,
  sidebarCounts: true,
  sidebarSections: [...SECTION_IDS],
  sidebarCustom: [],
};

export interface Settings {
  preferences: Preferences;
  bindings: Binding[];
  packages: PackageSettings;
}

export function defaultSettings(): Settings {
  return {
    preferences: { ...DEFAULT_PREFERENCES },
    bindings: [...DEFAULT_BINDINGS],
    packages: structuredClone(DEFAULT_PACKAGES),
  };
}

/**
 * Settings are one commented TOML file, edited in the same vim editor used for
 * mail. The file is generated from the tables below rather than kept as a
 * literal, so an option can never exist in the code without appearing in the
 * file with its explanation and default.
 */
export interface SectionSpec {
  id: string;
  title: string;
  blurb: string;
  /** Everything after the first advanced section sits below the divider. */
  advanced: boolean;
}

export const SECTIONS: SectionSpec[] = [
  {
    id: "general",
    title: "General",
    blurb: "Where ecr starts, and how moving around behaves.",
    advanced: false,
  },
  {
    id: "appearance",
    title: "Appearance",
    blurb: "Which palette the client wears.",
    advanced: false,
  },
  {
    id: "sidebar",
    title: "Sidebar",
    blurb: "What the left-hand column shows, and how densely.",
    advanced: false,
  },
  {
    id: "reading",
    title: "Reading",
    blurb: "How messages are shown, and when they count as read.",
    advanced: false,
  },
  {
    id: "composing",
    title: "Composing",
    blurb: "Replying, and how the editor opens.",
    advanced: false,
  },
  {
    id: "performance",
    title: "Performance",
    blurb: "Leave these alone unless the client feels slow.",
    advanced: true,
  },
];

/**
 * Who owns an option.
 *
 * `server` is anything about the mail itself, and is one answer for everyone:
 * the query you open on, whether HTML wins, when a message counts as read.
 * `client` is anything about the device you are reading on — a phone wants a
 * smaller page, a denser sidebar and a composer that fills the screen, and it
 * would be wrong to make a laptop agree.
 */
export type Scope = "server" | "client";

export interface PreferenceDoc {
  section: string;
  scope: Scope;
  doc: string;
  /** The permitted values, when they are not simply true or false. */
  values?: string;
}

export const PREFERENCE_DOCS: Record<keyof Preferences, PreferenceDoc> = {
  startQuery: {
    section: "general",
    scope: "server",
    doc: "The notmuch query ecr opens on. Any query works: tag:inbox, tag:unread\nand date:today are the usual choices.",
  },
  followSelection: {
    section: "general",
    scope: "client",
    doc: "Move through a list and the right-hand pane follows as you go. Turn this\noff to open threads only with Enter.",
  },
  theme: {
    section: "appearance",
    scope: "client",
    doc: "The theme file to load, relative to this file's own directory. The\nshipped presets are written into themes/ on first run; copy one, edit it,\nand point this at your copy. Editing a preset in place works too, but a\nnew release will not update a file you have changed.",
    values: "themes/ecr-dark.toml | themes/tokyonight.toml | any file you write",
  },
  sidebarIcons: {
    section: "sidebar",
    scope: "client",
    doc: "Show a glyph before each entry. Off gives a plain text list.",
  },
  sidebarLeaders: {
    section: "sidebar",
    scope: "client",
    doc: "Draw a dotted leader from each label across to its count, so the eye\ncan follow a long row to the right number.",
  },
  sidebarCounts: {
    section: "sidebar",
    scope: "client",
    doc: "Fetch and show how many messages each entry matches. Turning this off\nmeans the sidebar costs no requests at all.",
  },
  sidebarSections: {
    section: "sidebar",
    scope: "client",
    doc: "Which sections appear, and in what order. Drop one to hide it entirely;\ntags, people and lists are gathered from the database, so an empty list\nleaves only the mailboxes.",
    values: "a list of: mailboxes, tags, people, lists",
  },
  sidebarCustom: {
    section: "sidebar",
    scope: "client",
    doc: 'Your own entries, appended below the sections above. Each is a name, a\nnotmuch query and an optional glyph, and each is narrowed to the account\nit appears under:\ncustom = [ { name = "Patches", query = "subject:PATCH", icon = "◆" } ]',
    values: "a list of { name, query, icon } tables",
  },
  preferHtml: {
    section: "reading",
    scope: "server",
    doc: "Show the HTML part of a message rather than its plain-text alternative.\nEither way, t switches the message in front of you.",
  },
  loadRemoteImages: {
    section: "reading",
    scope: "server",
    doc: "Load images hosted elsewhere without asking. Leaving this off is what\nstops a sender learning that you opened their mail; i loads them once.",
  },
  expandNewest: {
    section: "reading",
    scope: "server",
    doc: "Open a thread with its newest message expanded and the rest folded.",
  },
  markReadOnOpen: {
    section: "reading",
    scope: "server",
    doc: "Drop the unread tag once a message has actually been on screen.",
  },
  markReadDelay: {
    section: "reading",
    scope: "server",
    doc: "How long it must stay on screen first, in milliseconds. Raise this if\nscrolling past a message is marking it read.",
  },
  listDateFormat: {
    section: "reading",
    scope: "client",
    doc: "How dates are written in the message list. adaptive shows the clock for\ntoday, day and month for this year, and the full date before that — so the\ncolumn stays narrow without ever being ambiguous.",
    values: "adaptive | time | datetime | iso | relative",
  },
  timezone: {
    section: "reading",
    scope: "client",
    doc: "The IANA timezone every date is shown in, such as Asia/Kolkata or\nEurope/Berlin. Leave it empty to follow the machine ecr is displayed on.",
    values: "an IANA timezone name, or empty",
  },
  replyAll: {
    section: "composing",
    scope: "server",
    doc: "Make r reply to everyone. R always replies to everyone regardless.",
  },
  pinnedCompose: {
    section: "composing",
    scope: "client",
    doc: "Open the composer pinned to the bottom of the reading pane, so you can\nkeep reading while you write. A pinned draft survives navigation and is\nclosed only by sending it or discarding it with ZQ.",
  },
  editorStartMode: {
    section: "composing",
    scope: "client",
    doc: "Which vim mode the composer and this settings file open in.",
    values: "normal | insert",
  },
  pageSize: {
    section: "performance",
    scope: "client",
    doc: "How many threads are fetched per query. The list is windowed, so a large\nnumber costs bandwidth rather than frames.",
  },
};


/** The keys each side owns, derived from the table above so they cannot drift. */
const keysWithScope = (scope: Scope) =>
  (Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]).filter(
    (key) => PREFERENCE_DOCS[key].scope === scope,
  );

export const SERVER_KEYS: (keyof Preferences)[] = keysWithScope("server");
export const CLIENT_KEYS: (keyof Preferences)[] = keysWithScope("client");

/** Just the half `scope` owns, for writing it where that half is kept. */
export function preferencesInScope(
  preferences: Preferences,
  scope: Scope,
): Partial<Preferences> {
  const keys = scope === "server" ? SERVER_KEYS : CLIENT_KEYS;
  const out: Partial<Preferences> = {};
  for (const key of keys) out[key] = preferences[key] as never;
  return out;
}
