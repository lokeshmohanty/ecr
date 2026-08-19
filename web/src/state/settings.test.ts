import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  actionFromText,
  actionToText,
  defaultSettings,
  defaultToml,
  fromToml,
  toToml,
} from "./settings";
import { PACKAGE_IDS } from "./packages";
import { DEFAULT_BINDINGS } from "../keymap/engine";

const roundTrip = () => fromToml(toToml(defaultSettings())).settings;

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

describe("what ecr does out of the box", () => {
  it("follows the selection, so navigating updates the detail pane", () => {
    expect(DEFAULT_PREFERENCES.followSelection).toBe(true);
  });

  it("starts the editor in normal mode", () => {
    expect(DEFAULT_PREFERENCES.editorStartMode).toBe("normal");
  });

  it("marks a message read once it has been displayed", () => {
    expect(DEFAULT_PREFERENCES.markReadOnOpen).toBe(true);
  });

  it("waits a moment first, so scrolling past does not count", () => {
    expect(DEFAULT_PREFERENCES.markReadDelay).toBeGreaterThan(500);
  });

  it("shows a message the way it was written, images and all", () => {
    expect(DEFAULT_PREFERENCES.loadRemoteImages).toBe(true);
  });

  it("leaves every package to the user to manage", () => {
    for (const id of PACKAGE_IDS) {
      expect(defaultSettings().packages[id].management, id).toBe("self");
    }
  });
});

describe("robustness", () => {
  it("empty text yields the defaults without complaining", () => {
    const { settings, errors } = fromToml("");
    expect(errors).toEqual([]);
    expect(settings.preferences).toEqual(DEFAULT_PREFERENCES);
  });

  it("a file of nothing but comments is fine", () => {
    expect(fromToml("# nothing to see\n").errors).toEqual([]);
  });

  it("a query containing an equals sign survives", () => {
    const text = defaultToml().replace(
      'start_query = "tag:inbox"',
      'start_query = "tag:inbox and subject:a=b"',
    );
    expect(fromToml(text).settings.preferences.startQuery).toBe("tag:inbox and subject:a=b");
  });
});

describe("the detail-pane bindings survive the file", () => {
  it("keeps the scroll chords working in every pane", () => {
    const scroll = roundTrip().bindings.find((b) => b.keys === "C-e");
    expect(scroll?.action).toEqual({ kind: "scrollDown" });
    // No panes at all: a global binding, which is how the file writes one that
    // means the same thing wherever it is pressed.
    expect(scroll?.panes).toBeUndefined();
  });

  it("keeps j and k scrolling only where there is a message to scroll", () => {
    const scroll = roundTrip().bindings.find(
      (b) => b.keys === "j" && b.action.kind === "scrollDown",
    );
    expect(scroll?.panes).toEqual(["detail"]);
  });

  it("keeps the half-screen variant distinct from the line one", () => {
    expect(roundTrip().bindings.find((b) => b.keys === "C-d")?.action).toEqual({
      kind: "scrollDown",
      half: true,
    });
  });

  it("keeps conversation movement on its chords", () => {
    for (const keys of ["C-j", "C-n"]) {
      expect(roundTrip().bindings.find((b) => b.keys === keys)?.action, keys).toEqual({
        kind: "nextMessage",
      });
    }
  });

  it("keeps a binding that spans two panes spanning both", () => {
    expect(roundTrip().bindings.find((b) => b.keys === "j" && b.action.kind === "next")?.panes)
      .toEqual(["sidebar", "list"]);
  });

  it("keeps every description the help overlay shows", () => {
    for (const binding of roundTrip().bindings) {
      const original = DEFAULT_BINDINGS.find(
        (b) => b.keys === binding.keys && b.action.kind === binding.action.kind,
      );
      expect(binding.description, binding.keys).toBe(original?.description);
    }
  });

  it("keeps reply and reply-all distinct", () => {
    const bindings = roundTrip().bindings;
    const reply = bindings.find((b) => b.keys === "r" && b.action.kind === "reply");
    expect(reply?.action).toEqual({ kind: "reply", all: false });
    expect(bindings.find((b) => b.keys === "R")?.action).toEqual({ kind: "reply", all: true });
  });

  /**
   * `r` is two bindings on the same key in different panes, so a file that
   * carries only one of them silently drops refresh or drops reply — and which
   * one survives depends on the order they happen to be written in.
   */
  it("carries both of the r bindings, each with its panes", () => {
    const rs = roundTrip().bindings.filter((b) => b.keys === "r");
    expect(rs.map((b) => b.action.kind).sort()).toEqual(["refresh", "reply"]);
    expect(rs.find((b) => b.action.kind === "refresh")?.panes).toEqual(["sidebar", "list"]);
    expect(rs.find((b) => b.action.kind === "reply")?.panes).toEqual(["detail"]);
  });
});
