import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { DEFAULT_BINDINGS } from "../keymap/engine";
import { PACKAGE_IDS } from "./packages";
import {
  DEFAULT_PREFERENCES,
  PREFERENCE_DOCS,
  SECTIONS,
  defaultSettings,
  defaultToml,
  fromToml,
  toToml,
  tomlString,
  withValue,
} from "./settings";

const TEXT = defaultToml();

describe("the settings file", () => {
  it("is valid TOML", () => {
    expect(() => parseToml(TEXT)).not.toThrow();
  });

  it("documents every preference it exposes", () => {
    for (const key of Object.keys(DEFAULT_PREFERENCES)) {
      expect(PREFERENCE_DOCS[key as keyof typeof DEFAULT_PREFERENCES].doc.length, key).toBeGreaterThan(10);
    }
  });

  it("exposes every preference — nothing configurable is hidden", () => {
    const parsed = parseToml(TEXT) as Record<string, Record<string, unknown>>;
    const present = SECTIONS.flatMap((s) => Object.keys(parsed[s.id] ?? {}));
    expect(present.length).toBe(Object.keys(DEFAULT_PREFERENCES).length);
  });

  it("states the default of every option in a comment", () => {
    const defaults = TEXT.split("\n").filter((l) => l.trim().startsWith("# default:"));
    expect(defaults.length).toBe(Object.keys(DEFAULT_PREFERENCES).length);
  });

  it("puts the everyday sections before the advanced ones", () => {
    const order = SECTIONS.map((s) => TEXT.indexOf(`[${s.id}]`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const firstAdvanced = SECTIONS.findIndex((s) => s.advanced);
    expect(SECTIONS.slice(0, firstAdvanced).every((s) => !s.advanced)).toBe(true);
  });

  it("marks where the advanced half begins", () => {
    expect(TEXT).toContain("ADVANCED");
  });

  it("uses snake_case keys, as a TOML reader expects", () => {
    const parsed = parseToml(TEXT) as Record<string, Record<string, unknown>>;
    for (const section of SECTIONS) {
      for (const key of Object.keys(parsed[section.id] ?? {})) {
        expect(key, key).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it("groups keybindings by the pane they apply to", () => {
    const parsed = parseToml(TEXT) as { keybindings: Record<string, unknown> };
    expect(Object.keys(parsed.keybindings)).toContain("global");
    expect(Object.keys(parsed.keybindings)).toContain("list");
  });

  it("gives every package a management mode", () => {
    const parsed = parseToml(TEXT) as { packages: Record<string, { management: string }> };
    for (const id of PACKAGE_IDS) {
      expect(parsed.packages[id]?.management, id).toBe("self");
    }
  });

  it("lists the actions a keybinding may name", () => {
    for (const kind of ["archive", "togglePinned", "reply:all"]) {
      expect(TEXT).toContain(kind);
    }
  });
});

describe("round-tripping", () => {
  it("reads back exactly what it wrote", () => {
    const { settings, errors } = fromToml(TEXT);
    expect(errors).toEqual([]);
    expect(settings.preferences).toEqual(DEFAULT_PREFERENCES);
  });

  it("keeps every default binding", () => {
    const { settings } = fromToml(TEXT);
    const wrote = new Set(DEFAULT_BINDINGS.map((b) => `${b.keys}|${b.panes?.join(",") ?? ""}`));
    const read = new Set(settings.bindings.map((b) => `${b.keys}|${b.panes?.join(",") ?? ""}`));
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
    settings.packages.mbsync = { management: "ecr", config: 'IMAPAccount main\nHost "x"\n' };
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
    expect(errors[0]).toBe('line 2: unknown option "prefer_htmls" in [reading]');
  });

  it("rejects a preference of the wrong type", () => {
    const { errors } = fromToml("[reading]\nprefer_html = 3\n");
    expect(errors[0]).toBe("line 2: prefer_html expects true or false");
  });

  it("rejects an option filed under the wrong section", () => {
    const { errors } = fromToml("[reading]\nstart_query = \"x\"\n");
    expect(errors[0]).toBe('line 2: start_query belongs in [general], not [reading]');
  });

  it("rejects an unknown section", () => {
    const { errors } = fromToml("[nope]\nx = 1\n");
    expect(errors[0]).toBe('line 1: unknown section [nope]');
  });

  it("rejects an unknown action", () => {
    const { errors } = fromToml('[keybindings.list]\nteleport = ["z"]\n');
    expect(errors[0]).toBe('line 2: unknown action "teleport"');
  });

  it("rejects an unknown pane", () => {
    const { errors } = fromToml('[keybindings.footer]\nnext = ["z"]\n');
    expect(errors[0]).toBe("line 1: unknown pane \"footer\" in [keybindings]");
  });

  it("rejects a management mode it does not understand", () => {
    const { errors } = fromToml('[packages.notmuch]\nmanagement = "someone else"\n');
    expect(errors[0]).toBe("line 2: notmuch expects self or ecr");
  });

  it("accepts a single key without the array brackets", () => {
    const { settings, errors } = fromToml('[keybindings.list]\narchive = "e"\n');
    expect(errors).toEqual([]);
    expect(settings.bindings.some((b) => b.keys === "e" && b.action.kind === "archive")).toBe(true);
  });

  it("falls back to the default bindings when none are given", () => {
    const { settings } = fromToml("[reading]\nprefer_html = false\n");
    expect(settings.bindings.length).toBe(DEFAULT_BINDINGS.length);
  });

  it("collects every error rather than stopping at the first", () => {
    const { errors } = fromToml("[reading]\nprefer_html = 3\nexpand_newest = 9\n");
    expect(errors).toHaveLength(2);
  });
});

describe("editing a value in place", () => {
  it("changes only the line it names", () => {
    const before = defaultToml();
    const after = withValue(before, "[packages.mbsync]", "management", '"ecr"');
    const changed = after.split("\n").filter((line, i) => line !== before.split("\n")[i]);
    expect(changed).toEqual(['management = "ecr"']);
  });

  it("keeps comments the user wrote", () => {
    const text = '# mine\n[packages.notmuch]\n# and this\nmanagement = "self"\n';
    const after = withValue(text, "[packages.notmuch]", "management", '"ecr"');
    expect(after).toContain("# mine");
    expect(after).toContain("# and this");
    expect(after).toContain('management = "ecr"');
  });

  it("replaces a whole multi-line block, not just its first line", () => {
    const text = defaultToml();
    const withConfig = withValue(text, "[packages.mbsync]", "config", tomlString("a\nb\n"));
    const back = withValue(withConfig, "[packages.mbsync]", "config", tomlString("c\n"));
    expect(fromToml(back).errors).toEqual([]);
    expect(fromToml(back).settings.packages.mbsync.config).toBe("c\n");
  });

  it("adds the key when the section does not have it", () => {
    const after = withValue("[reading]\nprefer_html = true\n", "[reading]", "expand_newest", "false");
    expect(fromToml(after).settings.preferences.expandNewest).toBe(false);
  });

  it("adds the section when the file does not have it", () => {
    const after = withValue("[reading]\n", "[packages.msmtp]", "management", '"ecr"');
    expect(fromToml(after).settings.packages.msmtp.management).toBe("ecr");
  });

  it("does not disturb the section that follows", () => {
    const after = withValue(defaultToml(), "[packages.notmuch]", "management", '"ecr"');
    const { settings, errors } = fromToml(after);
    expect(errors).toEqual([]);
    expect(settings.packages.mbsync.management).toBe("self");
  });
});
