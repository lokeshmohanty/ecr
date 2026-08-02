import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { DEFAULT_BINDINGS } from "../keymap/engine";
import { PACKAGE_IDS } from "./packages";
import {
	CLIENT_KEYS,
	DEFAULT_PREFERENCES,
	PREFERENCE_DOCS,
	SECTIONS,
	SERVER_KEYS,
	defaultSettings,
	defaultToml,
	fromToml,
	toToml,
	tomlString,
	withValue,
} from "./settings";

const TEXT = defaultToml();

const snake = (key: string) =>
	key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe("the settings file", () => {
	it("is valid TOML", () => {
		expect(() => parseToml(TEXT)).not.toThrow();
	});

	it("documents every preference it exposes", () => {
		for (const key of Object.keys(DEFAULT_PREFERENCES)) {
			expect(
				PREFERENCE_DOCS[key as keyof typeof DEFAULT_PREFERENCES].doc.length,
				key,
			).toBeGreaterThan(10);
		}
	});

	it("exposes every shared preference — nothing the server owns is hidden", () => {
		const parsed = parseToml(TEXT) as Record<string, Record<string, unknown>>;
		const present = SECTIONS.flatMap((s) => Object.keys(parsed[s.id] ?? {}));
		expect(present.length).toBe(SERVER_KEYS.length);
	});

	it("keeps the device's own half out of the shared file", () => {
		const parsed = parseToml(TEXT) as Record<string, Record<string, unknown>>;
		const present = new Set(
			SECTIONS.flatMap((s) => Object.keys(parsed[s.id] ?? {})),
		);
		for (const key of CLIENT_KEYS) {
			expect(present.has(snake(key)), key).toBe(false);
		}
	});

	it("states the default of every option it does carry", () => {
		const defaults = TEXT.split("\n").filter((l) =>
			l.trim().startsWith("# default:"),
		);
		expect(defaults.length).toBe(SERVER_KEYS.length);
	});

	it("puts the everyday sections before the advanced ones", () => {
		const order = SECTIONS.map((s) => TEXT.indexOf(`[${s.id}]`)).filter(
			(i) => i !== -1,
		);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		const firstAdvanced = SECTIONS.findIndex((s) => s.advanced);
		expect(SECTIONS.slice(0, firstAdvanced).every((s) => !s.advanced)).toBe(
			true,
		);
	});

	it("writes no empty section for one the device owns entirely", () => {
		for (const section of SECTIONS) {
			const shared = SERVER_KEYS.some(
				(key) => PREFERENCE_DOCS[key].section === section.id,
			);
			expect(TEXT.includes(`[${section.id}]`), section.id).toBe(shared);
		}
	});

	it("uses snake_case keys, as a TOML reader expects", () => {
		const parsed = parseToml(TEXT) as Record<string, Record<string, unknown>>;
		for (const section of SECTIONS) {
			for (const key of Object.keys(parsed[section.id] ?? {})) {
				expect(key, key).toMatch(/^[a-z][a-z0-9_]*$/);
			}
		}
	});

	it("leaves keybindings to the device, which is where the keyboard is", () => {
		const parsed = parseToml(TEXT) as { keybindings?: unknown };
		expect(parsed.keybindings).toBeUndefined();
	});

	it("gives every package a management mode", () => {
		const parsed = parseToml(TEXT) as {
			packages: Record<string, { management: string }>;
		};
		for (const id of PACKAGE_IDS) {
			expect(parsed.packages[id]?.management, id).toBe("self");
		}
	});

	it("says where the other half went, so it does not read as lost", () => {
		expect(TEXT).toContain("device");
	});
});

describe("round-tripping", () => {
	it("reads back exactly what it wrote", () => {
		const { settings, errors } = fromToml(TEXT);
		expect(errors).toEqual([]);
		// The device's half is absent from the file, so it comes back as the
		// default — which is what `withClient` then lays this device's own over.
		expect(settings.preferences).toEqual(DEFAULT_PREFERENCES);
	});

	it("keeps every default binding", () => {
		const { settings } = fromToml(TEXT);
		const wrote = new Set(
			DEFAULT_BINDINGS.map((b) => `${b.keys}|${b.panes?.join(",") ?? ""}`),
		);
		const read = new Set(
			settings.bindings.map((b) => `${b.keys}|${b.panes?.join(",") ?? ""}`),
		);
		expect(read).toEqual(wrote);
	});

	it("survives a second trip unchanged", () => {
		const once = toToml(fromToml(TEXT).settings);
		expect(toToml(fromToml(once).settings)).toBe(once);
	});

	it("carries an edited preference through", () => {
		const edited = TEXT.replace("prefer_html = true", "prefer_html = false");
		expect(fromToml(edited).settings.preferences.preferHtml).toBe(false);
	});

	it("keeps a package's own config text", () => {
		const settings = defaultSettings();
		settings.packages.mbsync = {
			management: "ecr",
			config: 'IMAPAccount main\nHost "x"\n',
		};
		const back = fromToml(toToml(settings)).settings;
		expect(back.packages.mbsync).toEqual(settings.packages.mbsync);
	});
});

describe("reporting a bad file", () => {
	it("reports a syntax error with its line", () => {
		const { errors } = fromToml("[general]\nstart_query = \n");
		expect(errors[0]).toMatch(/^line 2:/);
	});

	it("keeps the defaults when the file will not parse", () => {
		const { settings } = fromToml("[[[nonsense");
		expect(settings.preferences).toEqual(DEFAULT_PREFERENCES);
	});

	it("names an unknown option and where it is", () => {
		const { errors } = fromToml("[reading]\nprefer_htmls = true\n");
		expect(errors[0]).toBe(
			'line 2: unknown option "prefer_htmls" in [reading]',
		);
	});

	it("rejects a preference of the wrong type", () => {
		const { errors } = fromToml("[reading]\nprefer_html = 3\n");
		expect(errors[0]).toBe("line 2: prefer_html expects true or false");
	});

	it("rejects an option filed under the wrong section", () => {
		const { errors } = fromToml('[reading]\nstart_query = "x"\n');
		expect(errors[0]).toBe(
			"line 2: start_query belongs in [general], not [reading]",
		);
	});

	it("rejects an unknown section", () => {
		const { errors } = fromToml("[nope]\nx = 1\n");
		expect(errors[0]).toBe("line 1: unknown section [nope]");
	});

	it("rejects an unknown action", () => {
		const { errors } = fromToml('[keybindings.list]\nteleport = ["z"]\n');
		expect(errors[0]).toBe('line 2: unknown action "teleport"');
	});

	it("rejects an unknown pane", () => {
		const { errors } = fromToml('[keybindings.footer]\nnext = ["z"]\n');
		expect(errors[0]).toBe('line 1: unknown pane "footer" in [keybindings]');
	});

	it("rejects a management mode it does not understand", () => {
		const { errors } = fromToml(
			'[packages.notmuch]\nmanagement = "someone else"\n',
		);
		expect(errors[0]).toBe("line 2: notmuch expects self or ecr");
	});

	it("accepts a single key without the array brackets", () => {
		const { settings, errors } = fromToml(
			'[keybindings.list]\narchive = "e"\n',
		);
		expect(errors).toEqual([]);
		expect(
			settings.bindings.some(
				(b) => b.keys === "e" && b.action.kind === "archive",
			),
		).toBe(true);
	});

	it("falls back to the default bindings when none are given", () => {
		const { settings } = fromToml("[reading]\nprefer_html = false\n");
		expect(settings.bindings.length).toBe(DEFAULT_BINDINGS.length);
	});

	it("keeps the default for an action a keybindings section does not mention", () => {
		const { settings, errors } = fromToml(
			'[keybindings.list]\narchive = "e"\n',
		);
		expect(errors).toEqual([]);
		// The customized action uses the file's key, and the default it replaced is gone.
		expect(
			settings.bindings.some(
				(b) => b.keys === "e" && b.action.kind === "archive",
			),
		).toBe(true);
		expect(
			settings.bindings.some(
				(b) => b.keys === "a" && b.action.kind === "archive",
			),
		).toBe(false);
		// An action the section omits keeps its default key, so Space/v/t still work.
		expect(
			settings.bindings.some(
				(b) => b.keys === " " && b.action.kind === "toggleSelect",
			),
		).toBe(true);
		expect(
			settings.bindings.some(
				(b) => b.keys === "v" && b.action.kind === "visualSelect",
			),
		).toBe(true);
		expect(
			settings.bindings.some(
				(b) => b.keys === "t" && b.action.kind === "tagPrompt",
			),
		).toBe(true);
	});

	it("does not let a global binding shadow a default in a pane it did not name", () => {
		// `next` made global with `j`; the default `j`→scrollDown in the detail pane
		// is not mentioned, so it survives — pane-specific wins in the engine.
		const { settings } = fromToml('[keybindings.global]\nnext = ["j"]\n');
		const scroll = settings.bindings.find(
			(b) => b.keys === "j" && b.action.kind === "scrollDown",
		);
		expect(scroll).toBeTruthy();
		expect(scroll?.panes).toEqual(["detail"]);
	});

	it("collects every error rather than stopping at the first", () => {
		const { errors } = fromToml(
			"[reading]\nprefer_html = 3\nexpand_newest = 9\n",
		);
		expect(errors).toHaveLength(2);
	});
});

describe("editing a value in place", () => {
	it("changes only the line it names", () => {
		const before = defaultToml();
		const after = withValue(before, "[packages.mbsync]", "management", '"ecr"');
		const changed = after
			.split("\n")
			.filter((line, i) => line !== before.split("\n")[i]);
		expect(changed).toEqual(['management = "ecr"']);
	});

	it("keeps comments the user wrote", () => {
		const text =
			'# mine\n[packages.notmuch]\n# and this\nmanagement = "self"\n';
		const after = withValue(text, "[packages.notmuch]", "management", '"ecr"');
		expect(after).toContain("# mine");
		expect(after).toContain("# and this");
		expect(after).toContain('management = "ecr"');
	});

	it("replaces a whole multi-line block, not just its first line", () => {
		const text = defaultToml();
		const withConfig = withValue(
			text,
			"[packages.mbsync]",
			"config",
			tomlString("a\nb\n"),
		);
		const back = withValue(
			withConfig,
			"[packages.mbsync]",
			"config",
			tomlString("c\n"),
		);
		expect(fromToml(back).errors).toEqual([]);
		expect(fromToml(back).settings.packages.mbsync.config).toBe("c\n");
	});

	it("adds the key when the section does not have it", () => {
		const after = withValue(
			"[reading]\nprefer_html = true\n",
			"[reading]",
			"expand_newest",
			"false",
		);
		expect(fromToml(after).settings.preferences.expandNewest).toBe(false);
	});

	it("adds the section when the file does not have it", () => {
		const after = withValue(
			"[reading]\n",
			"[packages.msmtp]",
			"management",
			'"ecr"',
		);
		expect(fromToml(after).settings.packages.msmtp.management).toBe("ecr");
	});

	it("does not disturb the section that follows", () => {
		const after = withValue(
			defaultToml(),
			"[packages.notmuch]",
			"management",
			'"ecr"',
		);
		const { settings, errors } = fromToml(after);
		expect(errors).toEqual([]);
		expect(settings.packages.mbsync.management).toBe("self");
	});
});
