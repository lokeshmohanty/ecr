import { describe, expect, it } from "vitest";
import { handleKey, initialState, position, type EditorState } from "./vim";

const type = (state: EditorState, keys: string): EditorState =>
  keys.split("").reduce((s, key) => handleKey(s, { key }), state);

const press = (state: EditorState, key: string): EditorState => handleKey(state, { key });

function normal(text: string, caret = 0): EditorState {
  return { ...initialState(text, "normal"), caret };
}

describe("modes", () => {
  it("starts in insert so composing is immediate", () => {
    expect(initialState("hi").mode).toBe("insert");
  });

  it("escape leaves insert mode", () => {
    expect(press(initialState("hi"), "Escape").mode).toBe("normal");
  });

  it("i enters insert", () => {
    expect(press(normal("hi"), "i").mode).toBe("insert");
  });

  it("a enters insert after the caret", () => {
    const state = press(normal("hi", 0), "a");
    expect(state.mode).toBe("insert");
    expect(state.caret).toBe(1);
  });

  it("A appends at the end of the line", () => {
    const state = press(normal("hello\nworld", 1), "A");
    expect(state.caret).toBe(5);
  });
});

describe("typing", () => {
  it("inserts characters at the caret", () => {
    expect(type(initialState(""), "abc").text).toBe("abc");
  });

  it("Enter inserts a newline", () => {
    const state = press(type(initialState(""), "ab"), "Enter");
    expect(state.text).toBe("ab\n");
  });

  it("Backspace removes the character before the caret", () => {
    expect(press(type(initialState(""), "abc"), "Backspace").text).toBe("ab");
  });

  it("Backspace at the start does nothing", () => {
    expect(press(initialState(""), "Backspace").text).toBe("");
  });
});

describe("motions", () => {
  it("hjkl move by character and line", () => {
    const state = normal("abc\ndef", 0);
    expect(press(state, "l").caret).toBe(1);
    expect(press(normal("abc\ndef", 2), "h").caret).toBe(1);
    expect(press(normal("abc\ndef", 1), "j").caret).toBe(5);
    expect(press(normal("abc\ndef", 5), "k").caret).toBe(1);
  });

  it("h stops at the line start rather than wrapping", () => {
    expect(press(normal("abc\ndef", 4), "h").caret).toBe(4);
  });

  it("l stops at the line end", () => {
    expect(press(normal("abc\ndef", 3), "l").caret).toBe(3);
  });

  it("0 and $ go to the ends of the line", () => {
    expect(press(normal("abc\ndef", 5), "0").caret).toBe(4);
    expect(press(normal("abc\ndef", 4), "$").caret).toBe(7);
  });

  it("^ goes to the first non-blank", () => {
    expect(press(normal("   abc", 5), "^").caret).toBe(3);
  });

  it("w and b move by word", () => {
    expect(press(normal("one two three", 0), "w").caret).toBe(4);
    expect(press(normal("one two three", 4), "b").caret).toBe(0);
  });

  it("gg and G go to the ends of the buffer", () => {
    expect(type(normal("a\nb\nc", 4), "gg").caret).toBe(0);
    expect(press(normal("a\nb\nc", 0), "G").caret).toBe(5);
  });
});

describe("editing", () => {
  it("x deletes the character under the caret", () => {
    expect(press(normal("abc", 1), "x").text).toBe("ac");
  });

  it("dd deletes the line", () => {
    expect(type(normal("one\ntwo\nthree", 4), "dd").text).toBe("one\nthree");
  });

  it("dd on the last line leaves the rest intact", () => {
    expect(type(normal("one\ntwo", 4), "dd").text).toBe("one\n");
  });

  it("dw deletes a word", () => {
    expect(type(normal("one two three", 0), "dw").text).toBe("two three");
  });

  it("D deletes to the end of the line", () => {
    expect(press(normal("one two", 3), "D").text).toBe("one");
  });

  it("cw deletes a word and enters insert", () => {
    const state = type(normal("one two", 0), "cw");
    expect(state.text).toBe("two");
    expect(state.mode).toBe("insert");
  });

  it("o opens a line below and enters insert", () => {
    const state = press(normal("one\ntwo", 0), "o");
    expect(state.text).toBe("one\n\ntwo");
    expect(state.mode).toBe("insert");
  });

  it("O opens a line above", () => {
    const state = press(normal("one\ntwo", 4), "O");
    expect(state.text).toBe("one\n\ntwo");
    expect(state.mode).toBe("insert");
  });

  it("yy then p duplicates a line", () => {
    const yanked = type(normal("one\ntwo", 0), "yy");
    expect(yanked.register).toBe("one");
    expect(press(yanked, "p").text).toContain("one");
  });

  it("an unknown operator motion cancels cleanly", () => {
    const state = type(normal("one two", 0), "dz");
    expect(state.text).toBe("one two");
    expect(state.pending).toBe("");
  });
});

describe("leaving the editor", () => {
  it("ZZ submits", () => {
    const state = type(normal("body", 0), "ZZ");
    expect(state.submit).toBe(true);
    expect(state.cancel).toBe(false);
  });

  it("ZQ cancels", () => {
    const state = type(normal("body", 0), "ZQ");
    expect(state.cancel).toBe(true);
    expect(state.submit).toBe(false);
  });

  it("Z followed by anything else does nothing", () => {
    const state = type(normal("body", 0), "Zx");
    expect(state.submit).toBe(false);
    expect(state.cancel).toBe(false);
  });
});

describe("pending sequences", () => {
  it("shows the operator while it waits for a motion", () => {
    expect(press(normal("abc", 0), "d").pending).toBe("d");
  });

  it("escape clears a pending operator", () => {
    expect(press(press(normal("abc", 0), "d"), "Escape").pending).toBe("");
  });
});

describe("modifiers", () => {
  it("never swallows a ctrl chord", () => {
    const state = normal("abc", 0);
    expect(handleKey(state, { key: "d", ctrl: true })).toEqual(state);
  });

  it("never swallows a meta chord", () => {
    const state = initialState("abc");
    expect(handleKey(state, { key: "a", meta: true })).toEqual(state);
  });
});

describe("position", () => {
  it("reports 1-indexed line and column", () => {
    expect(position("abc\ndef", 0)).toEqual({ line: 1, column: 1 });
    expect(position("abc\ndef", 5)).toEqual({ line: 2, column: 2 });
  });
});
