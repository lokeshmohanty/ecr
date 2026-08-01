import { describe, expect, it } from "vitest";
import {
  actionFromText,
  actionToText,
  defaultSettings,
  fromText,
  toText,
  DEFAULT_PREFERENCES,
} from "./settings";

describe("round trip", () => {
  it("survives being written and read back", () => {
    const original = defaultSettings();
    const { settings, errors } = fromText(toText(original));

    expect(errors).toEqual([]);
    expect(settings.preferences).toEqual(original.preferences);
    expect(settings.bindings).toHaveLength(original.bindings.length);
  });

  it("keeps pane scoping through a round trip", () => {
    const { settings } = fromText(toText(defaultSettings()));
    const listArchive = settings.bindings.find(
      (b) => b.keys === "a" && b.action.kind === "archive",
    );
    expect(listArchive?.panes).toEqual(["list"]);
  });

  it("keeps reply and reply-all distinct", () => {
    const { settings } = fromText(toText(defaultSettings()));
    expect(settings.bindings.find((b) => b.keys === "r")?.action).toEqual({
      kind: "reply",
      all: false,
    });
    expect(settings.bindings.find((b) => b.keys === "R")?.action).toEqual({
      kind: "reply",
      all: true,
    });
  });
});

describe("preferences", () => {
  it("parses booleans, numbers and strings", () => {
    const { settings, errors } = fromText(
      "[preferences]\npageSize = 25\npreferHtml = false\nstartQuery = tag:unread\n",
    );

    expect(errors).toEqual([]);
    expect(settings.preferences.pageSize).toBe(25);
    expect(settings.preferences.preferHtml).toBe(false);
    expect(settings.preferences.startQuery).toBe("tag:unread");
  });

  it("keeps defaults for anything not mentioned", () => {
    const { settings } = fromText("[preferences]\npageSize = 10\n");
    expect(settings.preferences.expandNewest).toBe(DEFAULT_PREFERENCES.expandNewest);
  });

  it("reports an unknown preference with a line number", () => {
    const { errors } = fromText("[preferences]\nnonsense = 1\n");
    expect(errors[0]).toMatch(/line 2.*nonsense/);
  });

  it("rejects a non-boolean for a boolean", () => {
    const { errors } = fromText("[preferences]\npreferHtml = yes\n");
    expect(errors[0]).toMatch(/true or false/);
  });

  it("rejects a non-positive page size", () => {
    expect(fromText("[preferences]\npageSize = 0\n").errors[0]).toMatch(/positive number/);
    expect(fromText("[preferences]\npageSize = abc\n").errors[0]).toMatch(/positive number/);
  });

  it("allows a query containing an equals sign", () => {
    const { settings } = fromText("[preferences]\nstartQuery = subject:a=b\n");
    expect(settings.preferences.startQuery).toBe("subject:a=b");
  });
});

describe("keybindings", () => {
  it("parses keys, action and panes", () => {
    const { settings, errors } = fromText("[keybindings]\nn\tnext\tlist\n");

    expect(errors).toEqual([]);
    expect(settings.bindings).toEqual([
      { keys: "n", action: { kind: "next" }, description: "next", panes: ["list"] },
    ]);
  });

  it("treats an omitted pane list as global", () => {
    const { settings } = fromText("[keybindings]\nn\tnext\n");
    expect(settings.bindings[0]!.panes).toBeUndefined();
  });

  it("accepts several panes", () => {
    const { settings } = fromText("[keybindings]\nn\tnext\tlist,detail\n");
    expect(settings.bindings[0]!.panes).toEqual(["list", "detail"]);
  });

  it("reports an unknown action rather than dropping it silently", () => {
    const { errors } = fromText("[keybindings]\nn\tfrobnicate\n");
    expect(errors[0]).toMatch(/unknown action "frobnicate"/);
  });

  it("falls back to the defaults if every binding is invalid", () => {
    const { settings, errors } = fromText("[keybindings]\nn\tfrobnicate\n");
    expect(settings.bindings.length).toBeGreaterThan(10);
    expect(errors.some((e) => e.includes("keeping the defaults"))).toBe(true);
  });

  it("ignores comments and blank lines", () => {
    const { settings, errors } = fromText("[keybindings]\n# a comment\n\nn\tnext\n");
    expect(errors).toEqual([]);
    expect(settings.bindings).toHaveLength(1);
  });
});

describe("action text", () => {
  it("round-trips every action shape", () => {
    for (const text of ["next", "reply", "reply:all", "settings", "focusLeft"]) {
      const action = actionFromText(text);
      expect(action, text).not.toBeNull();
      expect(actionToText(action!)).toBe(text);
    }
  });

  it("returns null for something unknown", () => {
    expect(actionFromText("nope")).toBeNull();
  });
});

describe("robustness", () => {
  it("empty text yields defaults without complaining", () => {
    const { settings, errors } = fromText("");
    expect(errors).toEqual([]);
    expect(settings.preferences).toEqual(DEFAULT_PREFERENCES);
  });

  it("content before any section header is ignored", () => {
    const { errors } = fromText("stray = 1\n[preferences]\npageSize = 5\n");
    expect(errors).toEqual([]);
    expect(fromText("stray = 1\n[preferences]\npageSize = 5\n").settings.preferences.pageSize).toBe(5);
  });
});

describe("new preferences", () => {
  it("follows selection by default, so navigating updates the detail pane", () => {
    expect(DEFAULT_PREFERENCES.followSelection).toBe(true);
  });

  it("starts the editor in normal mode by default", () => {
    expect(DEFAULT_PREFERENCES.editorStartMode).toBe("normal");
  });

  it("parses the editor start mode", () => {
    const { settings, errors } = fromText("[preferences]\neditorStartMode = insert\n");
    expect(errors).toEqual([]);
    expect(settings.preferences.editorStartMode).toBe("insert");
  });

  it("rejects an editor start mode that is not a vim mode", () => {
    expect(fromText("[preferences]\neditorStartMode = shouting\n").errors[0]).toMatch(
      /normal or insert/,
    );
  });

  it("round-trips the new preferences", () => {
    const { settings } = fromText(toText(defaultSettings()));
    expect(settings.preferences.followSelection).toBe(DEFAULT_PREFERENCES.followSelection);
    expect(settings.preferences.editorStartMode).toBe(DEFAULT_PREFERENCES.editorStartMode);
  });
});

describe("packages", () => {
  it("defaults every package to self-managed", () => {
    const { settings } = fromText("");
    for (const id of Object.keys(settings.packages)) {
      expect(settings.packages[id as keyof typeof settings.packages].management).toBe("self");
    }
  });

  it("parses a management choice", () => {
    const { settings, errors } = fromText("[packages]\nnotmuch = ecr\n");
    expect(errors).toEqual([]);
    expect(settings.packages.notmuch.management).toBe("ecr");
  });

  it("rejects an unknown management mode", () => {
    expect(fromText("[packages]\nnotmuch = magic\n").errors[0]).toMatch(/self or ecr/);
  });

  it("rejects an unknown package", () => {
    expect(fromText("[packages]\nnonesuch = ecr\n").errors[0]).toMatch(/unknown package/);
  });

  it("round-trips through text", () => {
    const original = defaultSettings();
    original.packages.mbsync.management = "ecr";

    const { settings, errors } = fromText(toText(original));
    expect(errors).toEqual([]);
    expect(settings.packages.mbsync.management).toBe("ecr");
  });

  it("writes a packages section people can find", () => {
    expect(toText(defaultSettings())).toContain("[packages]");
  });
});

describe("reading preferences", () => {
  it("marks a message read once it has been displayed, by default", () => {
    expect(DEFAULT_PREFERENCES.markReadOnOpen).toBe(true);
  });

  it("waits a moment before doing so, so scrolling past does not count", () => {
    expect(DEFAULT_PREFERENCES.markReadDelay).toBeGreaterThan(0);
  });

  it("parses both", () => {
    const { settings, errors } = fromText(
      "[preferences]\nmarkReadOnOpen = false\nmarkReadDelay = 3000\n",
    );
    expect(errors).toEqual([]);
    expect(settings.preferences.markReadOnOpen).toBe(false);
    expect(settings.preferences.markReadDelay).toBe(3000);
  });

  it("rejects a negative delay", () => {
    expect(fromText("[preferences]\nmarkReadDelay = -1\n").errors[0]).toMatch(/positive number/);
  });

  it("round-trips", () => {
    const { settings } = fromText(toText(defaultSettings()));
    expect(settings.preferences.markReadOnOpen).toBe(DEFAULT_PREFERENCES.markReadOnOpen);
    expect(settings.preferences.markReadDelay).toBe(DEFAULT_PREFERENCES.markReadDelay);
  });
});

describe("the new detail-pane bindings survive settings", () => {
  it("keeps scrolling bound to the detail pane", () => {
    const { settings } = fromText(toText(defaultSettings()));
    const scroll = settings.bindings.find((b) => b.keys === "C-e");

    expect(scroll?.action).toEqual({ kind: "scrollDown" });
    expect(scroll?.panes).toEqual(["detail"]);
  });

  it("keeps the half-screen variant distinct from the line one", () => {
    const { settings } = fromText(toText(defaultSettings()));
    expect(settings.bindings.find((b) => b.keys === "C-d")?.action).toEqual({
      kind: "scrollDown",
      half: true,
    });
  });

  it("keeps conversation movement on its chords", () => {
    const { settings } = fromText(toText(defaultSettings()));
    for (const keys of ["C-j", "C-n"]) {
      expect(settings.bindings.find((b) => b.keys === keys)?.action, keys).toEqual({
        kind: "nextMessage",
      });
    }
  });
});
