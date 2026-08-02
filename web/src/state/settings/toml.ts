/**
 * The file itself: generating it, parsing it back, and editing one value in
 * place without disturbing a byte around it.
 */
import { parse as parseToml } from "smol-toml";

import {
	DEFAULT_BINDINGS,
	type Action,
	type Binding,
	type Pane,
} from "../../keymap/engine";
import { DATE_FORMATS, isDateFormat, isTimezone } from "../datetime";
import {
	SECTION_IDS,
	isSectionId,
	type CustomView,
	type SectionId,
} from "../views";
import {
	PACKAGE_IDS,
	PACKAGE_LABELS,
	type Management,
	type PackageId,
} from "../packages";
import {
	DEFAULT_PREFERENCES,
	PREFERENCE_DOCS,
	SECTIONS,
	defaultSettings,
	type Preferences,
	type SectionSpec,
	type Settings,
} from "./schema";

const PANE_ORDER: Pane[] = ["sidebar", "list", "detail"];
const GLOBAL = "global";

function snake(key: string): string {
	return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function camel(key: string): string {
	return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function literal(
	value: string | number | boolean | readonly string[] | readonly CustomView[],
): string {
	if (Array.isArray(value)) {
		const items = (value as readonly (string | CustomView)[]).map((v) =>
			typeof v === "string"
				? JSON.stringify(v)
				: `{ name = ${JSON.stringify(v.name)}, query = ${JSON.stringify(v.query)}, icon = ${JSON.stringify(v.icon)} }`,
		);
		return `[${items.join(", ")}]`;
	}
	return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function comment(text: string, indent = "# "): string[] {
	return text.split("\n").map((line) => `${indent}${line}`.trimEnd());
}

const RULE = "# " + "─".repeat(74);

/** Every action a keybinding may name, for the legend in the file. */
export function actionNames(): string[] {
	const names = new Set<string>(
		DEFAULT_BINDINGS.map((b) => actionToText(b.action)),
	);
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
		"#",
		"# This is the half every client shares, because it is about the mail. The",
		"# rest — theme, sidebar, dates, keybindings, page size — belongs to the",
		"# device you are reading on and is set on its own settings page, so a phone",
		"# and a desktop can differ without arguing. Anything of that kind left in",
		"# this file is still read once, and adopted by a device that has none yet.",
		RULE,
	];

	let dividerWritten = false;
	for (const section of SECTIONS) {
		// A section whose every option belongs to the device would be an empty
		// table with a heading, which reads as something having gone missing.
		const keys = (
			Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]
		).filter(
			(key) =>
				PREFERENCE_DOCS[key].section === section.id &&
				PREFERENCE_DOCS[key].scope === "server",
		);
		if (keys.length === 0) continue;

		if (section.advanced && !dividerWritten) {
			out.push(
				"",
				RULE,
				"# ADVANCED — nothing below this line needs touching to use ecr.",
				RULE,
			);
			dividerWritten = true;
		}
		out.push("", `# ${section.title} — ${section.blurb}`, `[${section.id}]`);

		for (const key of keys) {
			const doc = PREFERENCE_DOCS[key];
			out.push("");
			out.push(...comment(doc.doc));
			if (doc.values) out.push(`# values: ${doc.values}`);
			out.push(`# default: ${literal(DEFAULT_PREFERENCES[key])}`);
			out.push(`${snake(key)} = ${literal(settings.preferences[key])}`);
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
		out.push(
			"",
			`# ${label.title} — ${label.purpose} (${label.file})`,
			`[packages.${id}]`,
		);
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
export function withValue(
	text: string,
	header: string,
	key: string,
	literal: string,
): string {
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

	const pattern = new RegExp(
		`^\\s*"?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*=`,
	);
	for (let i = headerAt + 1; i < end; i += 1) {
		if (!pattern.test(lines[i]!)) continue;

		let last = i;
		const value = lines[i]!.slice(lines[i]!.indexOf("=") + 1).trim();
		if (
			value.startsWith('"""') &&
			!(value.length > 5 && value.endsWith('"""'))
		) {
			last = i + 1;
			while (last < end && !lines[last]!.includes('"""')) last += 1;
		}
		return [
			...lines.slice(0, i),
			`${key} = ${literal}`,
			...lines.slice(last + 1),
		].join("\n");
	}

	let at = end;
	while (at > headerAt + 1 && lines[at - 1]!.trim() === "") at -= 1;
	return [
		...lines.slice(0, at),
		`${key} = ${literal}`,
		...lines.slice(at),
	].join("\n");
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
		const message =
			(error as Error).message.split("\n")[0] ?? "could not be parsed";
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
			errors.push(
				`line ${lineOfHeader(text, name)}: unknown section [${name}]`,
			);
			continue;
		}
		readPreferences(section, value, text, settings, errors);
	}

	settings.bindings = mergeBindings(bindings);
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
			errors.push(
				`${at}: ${rawKey} belongs in [${doc.section}], not [${section.id}]`,
			);
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
			errors.push(
				`${at}: ${name} does not name a timezone: ${JSON.stringify(value)}`,
			);
			return;
		}
		preferences.timezone = value;
		return;
	}
	if (key === "sidebarSections") {
		if (!Array.isArray(value)) {
			errors.push(
				`${at}: ${name} expects a list, such as ["mailboxes", "tags"]`,
			);
			return;
		}
		const unknown = value.filter(
			(v) => typeof v !== "string" || !isSectionId(v),
		);
		if (unknown.length > 0) {
			errors.push(
				`${at}: ${name} does not know ${unknown.map((v) => JSON.stringify(v)).join(", ")} — expected ${SECTION_IDS.join(", ")}`,
			);
			return;
		}
		// Duplicates would render the same section twice and break the flat index
		// the keyboard walks.
		preferences.sidebarSections = [...new Set(value as SectionId[])];
		return;
	}
	if (key === "sidebarCustom") {
		if (!Array.isArray(value)) {
			errors.push(`${at}: ${name} expects a list of { name, query } tables`);
			return;
		}
		const rows: CustomView[] = [];
		for (const entry of value) {
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
				errors.push(
					`${at}: every ${name} entry is a table with a name and a query`,
				);
				return;
			}
			const row = entry as Record<string, unknown>;
			if (typeof row.name !== "string" || row.name.trim() === "") {
				errors.push(`${at}: every ${name} entry needs a name`);
				return;
			}
			if (typeof row.query !== "string" || row.query.trim() === "") {
				errors.push(`${at}: ${JSON.stringify(row.name)} needs a query`);
				return;
			}
			if (row.icon !== undefined && typeof row.icon !== "string") {
				errors.push(
					`${at}: the icon for ${JSON.stringify(row.name)} must be text`,
				);
				return;
			}
			rows.push({
				name: row.name,
				query: row.query,
				icon: typeof row.icon === "string" ? row.icon : "◆",
			});
		}
		preferences.sidebarCustom = rows;
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
function add(
	bindings: Binding[],
	keys: string,
	action: Action,
	name: string,
	pane: string,
): void {
	const existing = bindings.find(
		(b) => b.keys === keys && actionToText(b.action) === name,
	);
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
		DEFAULT_BINDINGS.find(
			(b) => b.keys === keys && actionToText(b.action) === name,
		) ?? DEFAULT_BINDINGS.find((b) => actionToText(b.action) === name);
	bindings.push({
		keys,
		action,
		description: described?.description ?? name,
		...(pane === GLOBAL ? {} : { panes: [pane as Pane] }),
	});
}

/**
 * A keybindings section customizes the actions it names and leaves every other
 * action at its default — so deleting a line falls back to the default, as the
 * file's header promises. A binding the file does not mention is kept from the
 * defaults, scoped to the panes the file did not override. A global binding
 * (no panes) covers every pane.
 */
export function mergeBindings(custom: Binding[]): Binding[] {
	const customized = new Set<string>();
	for (const binding of custom) {
		for (const pane of binding.panes ?? PANE_ORDER) {
			customized.add(`${actionToText(binding.action)}|${pane}`);
		}
	}

	const kept: Binding[] = [];
	for (const binding of DEFAULT_BINDINGS) {
		const panes = binding.panes ?? PANE_ORDER;
		const remaining = panes.filter(
			(pane) => !customized.has(`${actionToText(binding.action)}|${pane}`),
		);
		if (remaining.length === 0) continue;
		kept.push(
			remaining.length === panes.length
				? binding
				: { ...binding, panes: remaining },
		);
	}
	return [...custom, ...kept];
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
			errors.push(
				`line ${lineOfHeader(text, `packages.${id}`)}: unknown package "${id}"`,
			);
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;

		const header = `[packages.${id}]`;
		const { management, config } = entry as {
			management?: unknown;
			config?: unknown;
		};

		if (management !== undefined) {
			if (management !== "self" && management !== "ecr") {
				errors.push(
					`line ${lineOfKey(text, header, "management")}: ${id} expects self or ecr`,
				);
			} else {
				settings.packages[id as PackageId].management =
					management as Management;
			}
		}
		if (config !== undefined) {
			if (typeof config !== "string") {
				errors.push(
					`line ${lineOfKey(text, header, "config")}: ${id} config expects text`,
				);
			} else {
				settings.packages[id as PackageId].config = config;
			}
		}
	}
}

export function lineOfHeader(text: string, header: string): number {
	const lines = text.split("\n");
	const found = lines.findIndex(
		(line) => line.trim().replace(/\s/g, "") === `[${header}]`,
	);
	return found + 1 || 1;
}

/** An empty `header` means the key sits above every table, at the top level. */
export function lineOfKey(text: string, header: string, key: string): number {
	const lines = text.split("\n");
	const start =
		header === "" ? 0 : lines.findIndex((line) => line.trim() === header);
	const pattern = new RegExp(
		`^\\s*"?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*=`,
	);
	for (let i = Math.max(start, 0); i < lines.length; i += 1) {
		if (pattern.test(lines[i]!)) return i + 1;
	}
	return start + 1 || 1;
}

export function actionToText(action: Action): string {
	if (action.kind === "reply") return action.all ? "reply:all" : "reply";
	if (action.kind === "mark") return `mark:${action.tag}`;
	if (
		(action.kind === "scrollDown" || action.kind === "scrollUp") &&
		action.half
	) {
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
