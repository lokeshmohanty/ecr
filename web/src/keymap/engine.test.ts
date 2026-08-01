import { describe, expect, it } from "vitest";
import { Keymap, SEQUENCE_TIMEOUT, type Mode, type Pane } from "./engine";

interface Options {
  mode?: Mode;
  editing?: boolean;
  pane?: Pane;
  now?: number;
}

const press = (map: Keymap, key: string, o: Options = {}) =>
  map.handle(
    { key },
    o.mode ?? "normal",
    o.editing ?? false,
    o.pane ?? "list",
    o.now,
  );

describe("single keys", () => {
  it("resolves an immediate binding", () => {
    const map = new Keymap();
    expect(press(map, "j")).toEqual({ type: "action", action: { kind: "next" }, consumed: true });
  });

  it("distinguishes case", () => {
    const map = new Keymap();
    expect(press(map, "r")).toMatchObject({ action: { kind: "reply", all: false } });
    expect(press(map, "R")).toMatchObject({ action: { kind: "reply", all: true } });
  });

  it("ignores a key that is bound to nothing", () => {
    const map = new Keymap();
    expect(press(map, "Q")).toEqual({ type: "ignored", consumed: false });
  });
});

describe("pane scoping", () => {
  it("Enter opens a thread in the list and selects a view in the sidebar", () => {
    const map = new Keymap();
    expect(press(map, "Enter", { pane: "list" })).toMatchObject({ action: { kind: "open" } });
    expect(press(map, "Enter", { pane: "sidebar" })).toMatchObject({ action: { kind: "select" } });
  });

  it("a list binding does not fire in another pane", () => {
    const map = new Keymap();
    expect(press(map, "a", { pane: "list" })).toMatchObject({ action: { kind: "archive" } });
    expect(press(map, "a", { pane: "detail" })).toEqual({ type: "ignored", consumed: false });
  });

  it("a global binding fires in every pane", () => {
    const map = new Keymap();
    for (const pane of ["sidebar", "list", "detail"] as Pane[]) {
      expect(press(map, "c", { pane }), pane).toMatchObject({ action: { kind: "compose" } });
    }
  });

  it("h and l move focus from any pane", () => {
    const map = new Keymap();
    for (const pane of ["sidebar", "list", "detail"] as Pane[]) {
      expect(press(map, "h", { pane })).toMatchObject({ action: { kind: "focusLeft" } });
      expect(press(map, "l", { pane })).toMatchObject({ action: { kind: "focusRight" } });
    }
  });

  it("a pane binding wins over a global one on the same keys", () => {
    const map = new Keymap([
      { keys: "z", action: { kind: "help" }, description: "global" },
      { keys: "z", action: { kind: "sync" }, description: "list only", panes: ["list"] },
    ]);
    expect(press(map, "z", { pane: "list" })).toMatchObject({ action: { kind: "sync" } });
    expect(press(map, "z", { pane: "detail" })).toMatchObject({ action: { kind: "help" } });
  });

  it("describe narrows to a pane", () => {
    const map = new Keymap();
    const detail = map.describe("detail");
    expect(detail.some((b) => b.keys === "za")).toBe(true);
    expect(detail.some((b) => b.keys === "a" && b.panes?.includes("list"))).toBe(false);
  });
});

describe("multi-key sequences", () => {
  it("reports a partial sequence as pending", () => {
    const map = new Keymap();
    expect(press(map, "g")).toEqual({ type: "pending", sequence: "g", consumed: true });
  });

  it("completes a sequence on the second key", () => {
    const map = new Keymap();
    press(map, "g");
    expect(press(map, "g")).toMatchObject({ action: { kind: "first" } });
    expect(map.sequence).toBe("");
  });

  it("abandons a sequence that cannot complete", () => {
    const map = new Keymap();
    press(map, "z", { pane: "detail" });
    expect(press(map, "q", { pane: "detail" })).toMatchObject({ action: { kind: "closeRight" } });
  });

  it("does not let a stale prefix swallow a later key", () => {
    const map = new Keymap();
    press(map, "g", { now: 0 });
    expect(press(map, "j", { now: SEQUENCE_TIMEOUT + 1 })).toMatchObject({
      action: { kind: "next" },
    });
  });

  it("keeps a prefix alive inside the timeout", () => {
    const map = new Keymap();
    press(map, "g", { now: 0 });
    expect(press(map, "g", { now: SEQUENCE_TIMEOUT - 1 })).toMatchObject({
      action: { kind: "first" },
    });
  });

  it("handles bracket sequences", () => {
    const map = new Keymap();
    press(map, "]");
    expect(press(map, "a")).toMatchObject({ action: { kind: "nextAccount" } });
  });

  it("z sequences only exist in the detail pane", () => {
    const map = new Keymap();
    expect(press(map, "z", { pane: "detail" })).toMatchObject({ type: "pending" });
    map.reset();
    expect(press(map, "z", { pane: "list" })).toEqual({ type: "ignored", consumed: false });
  });
});

describe("modes and focus", () => {
  it("does not act on keys while a text field has focus", () => {
    const map = new Keymap();
    expect(press(map, "j", { editing: true })).toEqual({ type: "ignored", consumed: false });
  });

  it("does not act on keys in insert mode", () => {
    const map = new Keymap();
    expect(press(map, "j", { mode: "insert" })).toEqual({ type: "ignored", consumed: false });
  });

  it("escape leaves insert mode even though insert ignores other keys", () => {
    const map = new Keymap();
    expect(press(map, "Escape", { mode: "insert" })).toEqual({ type: "cancelled", consumed: true });
  });

  it("escape clears a pending sequence in normal mode", () => {
    const map = new Keymap();
    press(map, "g");
    expect(press(map, "Escape")).toEqual({ type: "cancelled", consumed: true });
    expect(map.sequence).toBe("");
  });

  it("escape in idle normal mode is not consumed, so the browser still sees it", () => {
    const map = new Keymap();
    expect(press(map, "Escape")).toEqual({ type: "ignored", consumed: false });
  });
});

describe("modifiers", () => {
  it("claims only the ctrl chords bound in the focused pane", () => {
    const map = new Keymap();
    // C-h is global; C-t is bound nowhere and belongs to the browser.
    expect(map.handle({ key: "h", ctrl: true }, "normal", false, "list")).toMatchObject({
      type: "action",
    });
    expect(map.handle({ key: "t", ctrl: true }, "normal", false, "list")).toEqual({
      type: "ignored",
      consumed: false,
    });
  });

  it("never claims a key held with meta, so browser shortcuts keep working", () => {
    const map = new Keymap();
    expect(map.handle({ key: "r", meta: true }, "normal", false, "list")).toEqual({
      type: "ignored",
      consumed: false,
    });
  });
});

describe("every default binding is reachable in its own pane", () => {
  const panes: Pane[] = ["sidebar", "list", "detail"];

  it("resolves each bound sequence to its action", () => {
    for (const pane of panes) {
      const map = new Keymap();
      for (const binding of map.describe(pane)) {
        // Chords are matched whole, not as a key sequence.
        if (binding.keys.startsWith("C-")) continue;
        map.reset();
        const keys = binding.keys === "Enter" ? ["Enter"] : binding.keys.split("");
        let outcome = null;
        for (const key of keys) outcome = press(map, key, { pane });

        expect(outcome, `${binding.keys} in ${pane}`).toMatchObject({
          type: "action",
          action: binding.action,
        });
      }
    }
  });

  it("no pane has two bindings on the same sequence", () => {
    for (const pane of panes) {
      const seen = new Map<string, number>();
      for (const binding of new Keymap().describe(pane)) {
        seen.set(binding.keys, (seen.get(binding.keys) ?? 0) + 1);
      }
      const clashes = [...seen.entries()].filter(([, n]) => n > 1);
      expect(clashes, `${pane}: ${JSON.stringify(clashes)}`).toEqual([]);
    }
  });
});

describe("custom bindings", () => {
  it("replace swaps the whole table", () => {
    const map = new Keymap();
    map.replace([{ keys: "n", action: { kind: "next" }, description: "next" }]);

    expect(press(map, "n")).toMatchObject({ action: { kind: "next" } });
    expect(press(map, "j")).toEqual({ type: "ignored", consumed: false });
  });
});

describe("ctrl chords", () => {
  it("move focus from any pane", () => {
    const map = new Keymap();
    expect(map.handle({ key: "h", ctrl: true }, "normal", false, "detail")).toMatchObject({
      action: { kind: "focusLeft" },
    });
    expect(map.handle({ key: "l", ctrl: true }, "normal", false, "sidebar")).toMatchObject({
      action: { kind: "focusRight" },
    });
  });

  it("work while a text field has focus, so you can leave an open editor", () => {
    const map = new Keymap();
    expect(map.handle({ key: "h", ctrl: true }, "insert", true, "detail")).toMatchObject({
      action: { kind: "focusLeft" },
    });
  });

  it("ctrl+b toggles the pinned split, even mid-edit", () => {
    const map = new Keymap();
    expect(map.handle({ key: "b", ctrl: true }, "insert", true, "detail")).toMatchObject({
      action: { kind: "togglePinned" },
    });
  });

  it("an unbound chord is left to the browser", () => {
    const map = new Keymap();
    expect(map.handle({ key: "t", ctrl: true }, "normal", false, "list")).toEqual({
      type: "ignored",
      consumed: false,
    });
  });

  it("a plain key is unaffected by the chord path", () => {
    const map = new Keymap();
    expect(map.handle({ key: "h" }, "normal", false, "list")).toMatchObject({
      action: { kind: "focusLeft" },
    });
  });
});

describe("scrolling and conversation movement in the detail pane", () => {
  const map = () => new Keymap();

  it("j and k scroll the reading pane rather than moving the list", () => {
    expect(press(map(), "j", { pane: "detail" })).toMatchObject({
      action: { kind: "scrollDown" },
    });
    expect(press(map(), "k", { pane: "detail" })).toMatchObject({
      action: { kind: "scrollUp" },
    });
  });

  it("j and k still move the cursor in the list and the sidebar", () => {
    expect(press(map(), "j", { pane: "list" })).toMatchObject({ action: { kind: "next" } });
    expect(press(map(), "j", { pane: "sidebar" })).toMatchObject({ action: { kind: "next" } });
  });

  it("ctrl-e and ctrl-y scroll a line at a time", () => {
    const m = map();
    expect(m.handle({ key: "e", ctrl: true }, "normal", false, "detail")).toMatchObject({
      action: { kind: "scrollDown" },
    });
    expect(m.handle({ key: "y", ctrl: true }, "normal", false, "detail")).toMatchObject({
      action: { kind: "scrollUp" },
    });
  });

  it("ctrl-d and ctrl-u scroll half a screen", () => {
    const m = map();
    expect(m.handle({ key: "d", ctrl: true }, "normal", false, "detail")).toMatchObject({
      action: { kind: "scrollDown", half: true },
    });
    expect(m.handle({ key: "u", ctrl: true }, "normal", false, "detail")).toMatchObject({
      action: { kind: "scrollUp", half: true },
    });
  });

  it("ctrl-j and ctrl-k walk the conversation", () => {
    const m = map();
    expect(m.handle({ key: "j", ctrl: true }, "normal", false, "detail")).toMatchObject({
      action: { kind: "nextMessage" },
    });
    expect(m.handle({ key: "k", ctrl: true }, "normal", false, "detail")).toMatchObject({
      action: { kind: "prevMessage" },
    });
  });

  it("ctrl-n and ctrl-p are the same movement", () => {
    const m = map();
    expect(m.handle({ key: "n", ctrl: true }, "normal", false, "detail")).toMatchObject({
      action: { kind: "nextMessage" },
    });
    expect(m.handle({ key: "p", ctrl: true }, "normal", false, "detail")).toMatchObject({
      action: { kind: "prevMessage" },
    });
  });

  it("ctrl-h and ctrl-l still move between panes from the detail pane", () => {
    const m = map();
    expect(m.handle({ key: "h", ctrl: true }, "normal", false, "detail")).toMatchObject({
      action: { kind: "focusLeft" },
    });
    expect(m.handle({ key: "l", ctrl: true }, "normal", false, "detail")).toMatchObject({
      action: { kind: "focusRight" },
    });
  });

  it("ctrl-b toggles the pinned split from anywhere", () => {
    for (const pane of ["sidebar", "list", "detail"] as Pane[]) {
      expect(map().handle({ key: "b", ctrl: true }, "normal", false, pane), pane).toMatchObject({
        action: { kind: "togglePinned" },
      });
    }
  });

  it("a chord bound only to the detail pane does not fire elsewhere", () => {
    expect(map().handle({ key: "e", ctrl: true }, "normal", false, "list")).toEqual({
      type: "ignored",
      consumed: false,
    });
  });

  it("chords still work while an editor holds focus", () => {
    expect(map().handle({ key: "h", ctrl: true }, "insert", true, "detail")).toMatchObject({
      action: { kind: "focusLeft" },
    });
  });
});
