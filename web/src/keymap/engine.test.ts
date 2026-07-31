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
  it("never claims a key held with ctrl", () => {
    const map = new Keymap();
    expect(map.handle({ key: "j", ctrl: true }, "normal", false, "list")).toEqual({
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
