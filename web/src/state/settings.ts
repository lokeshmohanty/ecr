import { parse as parseToml } from "smol-toml";

import { DEFAULT_BINDINGS, type Action, type Binding, type Pane } from "../keymap/engine";
import { DATE_FORMATS, isDateFormat, isTimezone, type DateFormat } from "./datetime";
import {
  DEFAULT_PACKAGES,
  PACKAGE_IDS,
  PACKAGE_LABELS,
  type Management,
  type PackageId,
  type PackageSettings,
} from "./packages";

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
};

export interface Settings {
  preferences: Preferences;
  bindings: Binding[];
  packages: PackageSettings;
}

const STORAGE_KEY = "ecr.settings.toml";
/** The shape settings had before they became a file; still read, never written. */
const LEGACY_KEY = "ecr.settings";

export function defaultSettings(): Settings {
  return {
    preferences: { ...DEFAULT_PREFERENCES },
    bindings: [...DEFAULT_BINDINGS],
    packages: structuredClone(DEFAULT_PACKAGES),
  };
}

/**
 * The server holds the real file; this is the copy that lets the client start
 * before the network answers, and keep working when it does not.
 */
export function loadSettings(): Settings {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text) return fromToml(text).settings;

    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return defaultSettings();

    const parsed = JSON.parse(legacy) as Partial<Settings>;
    return {
      preferences: { ...DEFAULT_PREFERENCES, ...(parsed.preferences ?? {}) },
      bindings: parsed.bindings?.length ? parsed.bindings : [...DEFAULT_BINDINGS],
      packages: { ...structuredClone(DEFAULT_PACKAGES), ...(parsed.packages ?? {}) },
    };
  } catch {
    return defaultSettings();
  }
}

/** The file as last seen, for starting up before the server answers. */
export function loadSettingsText(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || toToml(loadSettings());
  } catch {
    return defaultToml();
  }
}

export function saveSettings(settings: Settings, source = toToml(settings)): void {
  try {
    localStorage.setItem(STORAGE_KEY, source);
  } catch {
    // A full or disabled storage is not worth failing the edit over.
  }
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

export interface PreferenceDoc {
  section: string;
  doc: string;
  /** The permitted values, when they are not simply true or false. */
  values?: string;
}

export const PREFERENCE_DOCS: Record<keyof Preferences, PreferenceDoc> = {
  startQuery: {
    section: "general",
    doc: "The notmuch query ecr opens on. Any query works: tag:inbox, tag:unread\nand date:today are the usual choices.",
  },
  followSelection: {
    section: "general",
    doc: "Move through a list and the right-hand pane follows as you go. Turn this\noff to open threads only with Enter.",
  },
  theme: {
    section: "appearance",
    doc: "The theme file to load, relative to this file's own directory. The\nshipped presets are written into themes/ on first run; copy one, edit it,\nand point this at your copy. Editing a preset in place works too, but a\nnew release will not update a file you have changed.",
    values: "themes/ecr-dark.toml | themes/tokyonight.toml | any file you write",
  },
  preferHtml: {
    section: "reading",
    doc: "Show the HTML part of a message rather than its plain-text alternative.\nEither way, t switches the message in front of you.",
  },
  loadRemoteImages: {
    section: "reading",
    doc: "Load images hosted elsewhere without asking. Leaving this off is what\nstops a sender learning that you opened their mail; i loads them once.",
  },
  expandNewest: {
    section: "reading",
    doc: "Open a thread with its newest message expanded and the rest folded.",
  },
  markReadOnOpen: {
    section: "reading",
    doc: "Drop the unread tag once a message has actually been on screen.",
  },
  markReadDelay: {
    section: "reading",
    doc: "How long it must stay on screen first, in milliseconds. Raise this if\nscrolling past a message is marking it read.",
  },
  listDateFormat: {
    section: "reading",
    doc: "How dates are written in the message list. adaptive shows the clock for\ntoday, day and month for this year, and the full date before that — so the\ncolumn stays narrow without ever being ambiguous.",
    values: "adaptive | time | datetime | iso | relative",
  },
  timezone: {
    section: "reading",
    doc: "The IANA timezone every date is shown in, such as Asia/Kolkata or\nEurope/Berlin. Leave it empty to follow the machine ecr is displayed on.",
    values: "an IANA timezone name, or empty",
  },
  replyAll: {
    section: "composing",
    doc: "Make r reply to everyone. R always replies to everyone regardless.",
  },
  pinnedCompose: {
    section: "composing",
    doc: "Open the composer pinned to the bottom of the reading pane, so you can\nkeep reading while you write. A pinned draft survives navigation and is\nclosed only by sending it or discarding it with ZQ.",
  },
  editorStartMode: {
    section: "composing",
    doc: "Which vim mode the composer and this settings file open in.",
    values: "normal | insert",
  },
  pageSize: {
    section: "performance",
    doc: "How many threads are fetched per query. The list is windowed, so a large\nnumber costs bandwidth rather than frames.",
  },
};

const PANE_ORDER: Pane[] = ["sidebar", "list", "detail"];
const GLOBAL = "global";

function snake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function literal(value: string | number | boolean): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function comment(text: string, indent = "# "): string[] {
  return text.split("\n").map((line) => `${indent}${line}`.trimEnd());
}

const RULE = "# " + "─".repeat(74);

/** Every action a keybinding may name, for the legend in the file. */
export function actionNames(): string[] {
  const names = new Set<string>(DEFAULT_BINDINGS.map((b) => actionToText(b.action)));
  names.add("reply:all");
  names.add("mark:<tag>");
  return [...names].sort();
}

export function toToml(settings: Settings): string {
  const out: string[] = [
    RULE,
    "# ecr settings",
    "#",
    "# ZZ applies this file, ZQ discards it. Delete any line to fall back to its",
    "# default — the default is written above every option, so nothing here is",
    "# load-bearing and you can always start again from an empty file.",
    RULE,
  ];

  let dividerWritten = false;
  for (const section of SECTIONS) {
    if (section.advanced && !dividerWritten) {
      out.push("", RULE, "# ADVANCED — nothing below this line needs touching to use ecr.", RULE);
      dividerWritten = true;
    }
    out.push("", `# ${section.title} — ${section.blurb}`, `[${section.id}]`);

    for (const key of Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]) {
      const doc = PREFERENCE_DOCS[key];
      if (doc.section !== section.id) continue;
      out.push("");
      out.push(...comment(doc.doc));
      if (doc.values) out.push(`# values: ${doc.values}`);
      out.push(`# default: ${literal(DEFAULT_PREFERENCES[key])}`);
      out.push(`${snake(key)} = ${literal(settings.preferences[key])}`);
    }
  }

  out.push("", RULE, "# Keybindings", "#");
  out.push(
    ...comment(
      "One entry per action: the action name, then every key sequence that runs\nit. A chord is written C-x; a sequence is written as its keys, like gg or\n]a. Sections name the pane a binding applies in; [keybindings.global]\napplies everywhere, including while the composer has focus.\n\nActions:",
    ),
  );
  for (const line of wrap(actionNames().join("  "), 70)) out.push(`#   ${line}`.trimEnd());
  out.push(RULE);

  const byPane = new Map<string, Map<string, string[]>>();
  for (const binding of settings.bindings) {
    const panes = binding.panes?.length ? binding.panes : [GLOBAL];
    for (const pane of panes) {
      const table = byPane.get(pane) ?? new Map<string, string[]>();
      const action = actionToText(binding.action);
      table.set(action, [...(table.get(action) ?? []), binding.keys]);
      byPane.set(pane, table);
    }
  }

  for (const pane of [GLOBAL, ...PANE_ORDER]) {
    const table = byPane.get(pane);
    if (!table) continue;
    out.push("", `[keybindings.${pane}]`);
    for (const [action, keys] of table) {
      const name = /^[A-Za-z0-9_-]+$/.test(action) ? action : JSON.stringify(action);
      out.push(`${name} = [${keys.map((k) => JSON.stringify(k)).join(", ")}]`);
    }
  }

  out.push("", RULE, "# Packages", "#");
  out.push(
    ...comment(
      'How ecr treats each tool it drives. "self" means the machine already has a\nworking setup — ecr reads it and never writes it, and the config below is\nignored. "ecr" means ecr owns that file and this is where you edit it.',
    ),
  );
  out.push(RULE);

  for (const id of PACKAGE_IDS) {
    const pkg = settings.packages[id] ?? { management: "self", config: "" };
    const label = PACKAGE_LABELS[id];
    out.push("", `# ${label.title} — ${label.purpose} (${label.file})`, `[packages.${id}]`);
    out.push(`management = ${JSON.stringify(pkg.management)}`);
    out.push(`config = ${tomlString(pkg.config)}`);
  }

  return out.join("\n") + "\n";
}

/** A config file is many lines; TOML's triple-quoted form is the readable one. */
export function tomlString(value: string): string {
  if (value === "") return '""';
  return `"""\n${value.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"')}"""`;
}

/**
 * Replaces one value, leaving every other byte of the file alone. The settings
 * page can therefore toggle a switch without rewriting a file the user has
 * commented and reordered to their taste.
 */
export function withValue(text: string, header: string, key: string, literal: string): string {
  const lines = text.split("\n");
  const headerAt = lines.findIndex((line) => line.trim() === header);
  if (headerAt === -1) {
    return `${text.replace(/\s+$/, "")}\n\n${header}\n${key} = ${literal}\n`;
  }

  let end = lines.length;
  for (let i = headerAt + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i]!)) {
      end = i;
      break;
    }
  }

  const pattern = new RegExp(`^\\s*"?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*=`);
  for (let i = headerAt + 1; i < end; i += 1) {
    if (!pattern.test(lines[i]!)) continue;

    let last = i;
    const value = lines[i]!.slice(lines[i]!.indexOf("=") + 1).trim();
    if (value.startsWith('"""') && !(value.length > 5 && value.endsWith('"""'))) {
      last = i + 1;
      while (last < end && !lines[last]!.includes('"""')) last += 1;
    }
    return [...lines.slice(0, i), `${key} = ${literal}`, ...lines.slice(last + 1)].join("\n");
  }

  let at = end;
  while (at > headerAt + 1 && lines[at - 1]!.trim() === "") at -= 1;
  return [...lines.slice(0, at), `${key} = ${literal}`, ...lines.slice(at)].join("\n");
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function defaultToml(): string {
  return toToml(defaultSettings());
}

export interface ParseResult {
  settings: Settings;
  errors: string[];
}

export function fromToml(text: string): ParseResult {
  const settings = defaultSettings();
  const errors: string[] = [];

  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    const line = (error as { line?: number }).line ?? 1;
    const message = (error as Error).message.split("\n")[0] ?? "could not be parsed";
    return { settings, errors: [`line ${line}: ${message}`] };
  }

  const bindings: Binding[] = [];

  for (const [name, value] of Object.entries(doc)) {
    if (name === "keybindings") {
      readBindings(value, text, bindings, errors);
      continue;
    }
    if (name === "packages") {
      readPackages(value, text, settings, errors);
      continue;
    }
    const section = SECTIONS.find((s) => s.id === name);
    if (!section) {
      errors.push(`line ${lineOfHeader(text, name)}: unknown section [${name}]`);
      continue;
    }
    readPreferences(section, value, text, settings, errors);
  }

  settings.bindings = bindings.length > 0 ? bindings : [...DEFAULT_BINDINGS];
  return { settings, errors };
}

function readPreferences(
  section: SectionSpec,
  table: unknown,
  text: string,
  settings: Settings,
  errors: string[],
): void {
  if (typeof table !== "object" || table === null) return;

  for (const [rawKey, value] of Object.entries(table)) {
    const key = camel(rawKey) as keyof Preferences;
    const at = `line ${lineOfKey(text, `[${section.id}]`, rawKey)}`;
    const doc = PREFERENCE_DOCS[key];

    if (!doc) {
      errors.push(`${at}: unknown option "${rawKey}" in [${section.id}]`);
      continue;
    }
    if (doc.section !== section.id) {
      errors.push(`${at}: ${rawKey} belongs in [${doc.section}], not [${section.id}]`);
      continue;
    }
    assign(settings.preferences, key, rawKey, value, at, errors);
  }
}

function assign(
  preferences: Preferences,
  key: keyof Preferences,
  name: string,
  value: unknown,
  at: string,
  errors: string[],
): void {
  const current = DEFAULT_PREFERENCES[key];

  if (key === "editorStartMode") {
    if (value !== "normal" && value !== "insert") {
      errors.push(`${at}: ${name} expects normal or insert`);
      return;
    }
    preferences.editorStartMode = value;
    return;
  }
  if (key === "listDateFormat") {
    if (typeof value !== "string" || !isDateFormat(value)) {
      errors.push(`${at}: ${name} expects ${DATE_FORMATS.join(", ")}`);
      return;
    }
    preferences.listDateFormat = value;
    return;
  }
  // A typo here is silent otherwise: Intl falls back to the machine's zone, so
  // every date would look plausible and be wrong.
  if (key === "timezone") {
    if (typeof value !== "string") {
      errors.push(`${at}: ${name} expects text in quotes`);
      return;
    }
    if (!isTimezone(value)) {
      errors.push(`${at}: ${name} does not name a timezone: ${JSON.stringify(value)}`);
      return;
    }
    preferences.timezone = value;
    return;
  }
  if (typeof current === "boolean") {
    if (typeof value !== "boolean") {
      errors.push(`${at}: ${name} expects true or false`);
      return;
    }
    (preferences[key] as boolean) = value;
    return;
  }
  if (typeof current === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      errors.push(`${at}: ${name} expects a positive number`);
      return;
    }
    (preferences[key] as number) = Math.floor(value);
    return;
  }
  if (typeof value !== "string") {
    errors.push(`${at}: ${name} expects text in quotes`);
    return;
  }
  (preferences[key] as string) = value;
}

function readBindings(
  table: unknown,
  text: string,
  bindings: Binding[],
  errors: string[],
): void {
  if (typeof table !== "object" || table === null) return;

  for (const [pane, actions] of Object.entries(table)) {
    if (pane !== GLOBAL && !PANE_ORDER.includes(pane as Pane)) {
      errors.push(
        `line ${lineOfHeader(text, `keybindings.${pane}`)}: unknown pane "${pane}" in [keybindings]`,
      );
      continue;
    }
    if (typeof actions !== "object" || actions === null) continue;

    for (const [name, keys] of Object.entries(actions)) {
      const at = `line ${lineOfKey(text, `[keybindings.${pane}]`, name)}`;
      const action = actionFromText(name);
      if (!action) {
        errors.push(`${at}: unknown action "${name}"`);
        continue;
      }
      const list = typeof keys === "string" ? [keys] : keys;
      if (!Array.isArray(list) || list.some((k) => typeof k !== "string")) {
        errors.push(`${at}: ${name} expects a key or a list of keys`);
        continue;
      }
      for (const key of list as string[]) {
        add(bindings, key, action, name, pane);
      }
    }
  }
}

/**
 * A binding that applies in several panes is written once per pane; reading it
 * back merges those into the single binding the engine expects, so a file that
 * has been through this round trip is byte-identical.
 */
function add(bindings: Binding[], keys: string, action: Action, name: string, pane: string): void {
  const existing = bindings.find((b) => b.keys === keys && actionToText(b.action) === name);
  if (existing) {
    if (pane === GLOBAL) delete existing.panes;
    else if (existing.panes) {
      const panes = new Set([...existing.panes, pane as Pane]);
      existing.panes = PANE_ORDER.filter((p) => panes.has(p));
    }
    return;
  }
  // Keys first: several bindings share an action but describe it differently,
  // and the help overlay shows the description.
  const described =
    DEFAULT_BINDINGS.find((b) => b.keys === keys && actionToText(b.action) === name) ??
    DEFAULT_BINDINGS.find((b) => actionToText(b.action) === name);
  bindings.push({
    keys,
    action,
    description: described?.description ?? name,
    ...(pane === GLOBAL ? {} : { panes: [pane as Pane] }),
  });
}

function readPackages(
  table: unknown,
  text: string,
  settings: Settings,
  errors: string[],
): void {
  if (typeof table !== "object" || table === null) return;

  for (const [id, entry] of Object.entries(table)) {
    if (!PACKAGE_IDS.includes(id as PackageId)) {
      errors.push(`line ${lineOfHeader(text, `packages.${id}`)}: unknown package "${id}"`);
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;

    const header = `[packages.${id}]`;
    const { management, config } = entry as { management?: unknown; config?: unknown };

    if (management !== undefined) {
      if (management !== "self" && management !== "ecr") {
        errors.push(`line ${lineOfKey(text, header, "management")}: ${id} expects self or ecr`);
      } else {
        settings.packages[id as PackageId].management = management as Management;
      }
    }
    if (config !== undefined) {
      if (typeof config !== "string") {
        errors.push(`line ${lineOfKey(text, header, "config")}: ${id} config expects text`);
      } else {
        settings.packages[id as PackageId].config = config;
      }
    }
  }
}

export function lineOfHeader(text: string, header: string): number {
  const lines = text.split("\n");
  const found = lines.findIndex((line) => line.trim().replace(/\s/g, "") === `[${header}]`);
  return found + 1 || 1;
}

/** An empty `header` means the key sits above every table, at the top level. */
export function lineOfKey(text: string, header: string, key: string): number {
  const lines = text.split("\n");
  const start = header === "" ? 0 : lines.findIndex((line) => line.trim() === header);
  const pattern = new RegExp(`^\\s*"?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*=`);
  for (let i = Math.max(start, 0); i < lines.length; i += 1) {
    if (pattern.test(lines[i]!)) return i + 1;
  }
  return start + 1 || 1;
}

export function actionToText(action: Action): string {
  if (action.kind === "reply") return action.all ? "reply:all" : "reply";
  if (action.kind === "mark") return `mark:${action.tag}`;
  if ((action.kind === "scrollDown" || action.kind === "scrollUp") && action.half) {
    return `${action.kind}:half`;
  }
  return action.kind;
}

export function actionFromText(text: string): Action | null {
  if (text === "reply") return { kind: "reply", all: false };
  if (text === "reply:all") return { kind: "reply", all: true };
  if (text === "scrollDown:half") return { kind: "scrollDown", half: true };
  if (text === "scrollUp:half") return { kind: "scrollUp", half: true };
  if (text.startsWith("mark:")) return { kind: "mark", tag: text.slice(5) };

  const known = new Set(DEFAULT_BINDINGS.map((b) => b.action.kind));
  return known.has(text as Action["kind"]) ? ({ kind: text } as Action) : null;
}
