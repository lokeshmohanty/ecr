import { describe, expect, it } from "vitest";
import { softKeys } from "./soft-keys";
import { handleKey, initialState, type EditorState } from "./vim";

/** What the editor does when a soft keyboard sends one `beforeinput`. */
const soft = (state: EditorState, inputType: string, data: string | null = null): EditorState =>
  softKeys(inputType, data).reduce((s, key) => handleKey(s, { key }), state);

describe("soft keys", () => {
  it("splits a committed word into its characters", () => {
    expect(softKeys("insertText", "the")).toEqual(["t", "h", "e"]);
  });

  it("keeps an emoji whole rather than splitting its surrogate pair", () => {
    expect(softKeys("insertText", "🙂")).toEqual(["🙂"]);
  });

  it("names the keys behind backspace and return", () => {
    expect(softKeys("deleteContentBackward", null)).toEqual(["Backspace"]);
    expect(softKeys("insertLineBreak", null)).toEqual(["Enter"]);
    expect(softKeys("insertParagraph", null)).toEqual(["Enter"]);
  });

  it("has no key for an input type the editor does not model", () => {
    expect(softKeys("formatBold", null)).toEqual([]);
    expect(softKeys("historyUndo", null)).toEqual([]);
  });
});

describe("what the mode makes of them", () => {
  it("types into the buffer in insert mode", () => {
    expect(soft(initialState("", "insert"), "insertText", "hi").text).toBe("hi");
  });

  it("still commands in normal mode, so j does not become a letter", () => {
    const start = { ...initialState("one\ntwo", "normal"), caret: 0 };
    const state = soft(start, "insertText", "j");
    expect(state.text).toBe("one\ntwo");
    expect(state.caret).toBe(4);
  });

  it("enters insert on i, and then types", () => {
    const opened = soft(initialState("", "normal"), "insertText", "i");
    expect(opened.mode).toBe("insert");
    expect(soft(opened, "insertText", "ab").text).toBe("ab");
  });

  it("deletes backwards in insert mode", () => {
    expect(soft(initialState("ab", "insert"), "deleteContentBackward").text).toBe("a");
  });
});
