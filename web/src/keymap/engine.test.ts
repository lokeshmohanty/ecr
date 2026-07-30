import { describe, expect, it } from "vitest";
import { Keymap, SEQUENCE_TIMEOUT } from "./engine";

const press = (map: Keymap, key: string, mode: "normal" | "insert" | "command" | "search" = "normal", editing = false, now?: number) =>
  map.handle({ key }, mode, editing, now);

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

describe("multi-key sequences", () => {
  it("reports a partial sequence as pending", () => {
    const map = new Keymap();
    expect(press(map, "g")).toEqual({ type: "pending", sequence: "g", consumed: true });
    expect(map.sequence).toBe("g");
  });

  it("completes a sequence on the second key", () => {
    const map = new Keymap();
    press(map, "g");
    expect(press(map, "g")).toMatchObject({ action: { kind: "first" } });
    expect(map.sequence).toBe("");
  });

  it("abandons a sequence that cannot complete", () => {
    const map = new Keymap();
    press(map, "z");
    expect(press(map, "q")).toEqual({ type: "ignored", consumed: false });
    expect(map.sequence).toBe("");
  });

  it("does not let a stale prefix swallow a later key", () => {
    const map = new Keymap();
    press(map, "g", "normal", false, 0);

    const outcome = press(map, "j", "normal", false, SEQUENCE_TIMEOUT + 1);
    expect(outcome).toMatchObject({ action: { kind: "next" } });
  });

  it("keeps a prefix alive inside the timeout", () => {
    const map = new Keymap();
    press(map, "g", "normal", false, 0);
    expect(press(map, "g", "normal", false, SEQUENCE_TIMEOUT - 1)).toMatchObject({
      action: { kind: "first" },
    });
  });

  it("handles bracket sequences", () => {
    const map = new Keymap();
    press(map, "]");
    expect(press(map, "a")).toMatchObject({ action: { kind: "nextAccount" } });
  });
});

describe("modes and focus", () => {
  it("does not act on keys while a text field has focus", () => {
    const map = new Keymap();
    expect(press(map, "j", "normal", true)).toEqual({ type: "ignored", consumed: false });
  });

  it("does not act on keys in insert mode", () => {
    const map = new Keymap();
    expect(press(map, "j", "insert")).toEqual({ type: "ignored", consumed: false });
  });

  it("does not act on keys in command mode", () => {
    const map = new Keymap();
    expect(press(map, "a", "command")).toEqual({ type: "ignored", consumed: false });
  });

  it("escape leaves insert mode even though insert ignores other keys", () => {
    const map = new Keymap();
    expect(press(map, "Escape", "insert")).toEqual({ type: "cancelled", consumed: true });
  });

  it("escape leaves a text field", () => {
    const map = new Keymap();
    expect(press(map, "Escape", "normal", true)).toEqual({ type: "cancelled", consumed: true });
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
    expect(map.handle({ key: "j", ctrl: true }, "normal", false)).toEqual({
      type: "ignored",
      consumed: false,
    });
  });

  it("never claims a key held with meta, so browser shortcuts keep working", () => {
    const map = new Keymap();
    expect(map.handle({ key: "r", meta: true }, "normal", false)).toEqual({
      type: "ignored",
      consumed: false,
    });
  });
});

describe("mode entry", () => {
  it("enters command mode on colon", () => {
    const map = new Keymap();
    expect(press(map, ":")).toMatchObject({ action: { kind: "enterCommand" } });
  });

  it("enters search mode on slash", () => {
    const map = new Keymap();
    expect(press(map, "/")).toMatchObject({ action: { kind: "enterSearch" } });
  });
});

describe("every default binding is reachable", () => {
  it("resolves each bound sequence to its action", () => {
    const map = new Keymap();
    for (const binding of map.describe()) {
      map.reset();
      const keys = splitSequence(binding.keys);
      let outcome = null;
      for (const key of keys) {
        outcome = press(map, key);
      }
      expect(outcome, `binding ${binding.keys}`).toMatchObject({
        type: "action",
        action: binding.action,
      });
    }
  });

  it("has no duplicate sequences", () => {
    const seen = new Set<string>();
    for (const binding of new Keymap().describe()) {
      expect(seen.has(binding.keys), `duplicate ${binding.keys}`).toBe(false);
      seen.add(binding.keys);
    }
  });
});

function splitSequence(sequence: string): string[] {
  return sequence === "Enter" ? ["Enter"] : sequence.split("");
}
