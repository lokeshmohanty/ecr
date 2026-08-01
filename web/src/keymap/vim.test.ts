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

describe("undo and redo", () => {
  it("u undoes the last edit only", () => {
    // x, x leaves "llo"; one undo steps back to "ello".
    const after = type(normal("hello", 0), "xxu");
    expect(after.text).toBe("ello");
  });

  it("u repeated walks back through history", () => {
    const after = type(normal("hello", 0), "xxuu");
    expect(after.text).toBe("hello");
  });

  it("u at the beginning of history does nothing", () => {
    expect(type(normal("hello", 0), "uuu").text).toBe("hello");
  });

  it("undo restores the caret to where the edit happened", () => {
    const after = type(normal("one two", 4), "dwu");
    expect(after.text).toBe("one two");
    expect(after.caret).toBe(4);
  });

  it("a whole insert session undoes as one step", () => {
    let state = press(normal("x", 0), "i");
    state = type(state, "abc");
    state = press(state, "Escape");
    expect(press(state, "u").text).toBe("x");
  });
});

describe("counts", () => {
  it("3j moves three lines", () => {
    const state = type(normal("a\nb\nc\nd\ne", 0), "3j");
    expect(position(state.text, state.caret).line).toBe(4);
  });

  it("2dd deletes two lines", () => {
    expect(type(normal("a\nb\nc", 0), "2dd").text).toBe("c");
  });

  it("3x deletes three characters", () => {
    expect(type(normal("abcdef", 0), "3x").text).toBe("def");
  });

  it("a count larger than the buffer clamps", () => {
    const state = type(normal("a\nb", 0), "99j");
    expect(position(state.text, state.caret).line).toBe(2);
  });

  it("0 alone is still a motion, not the start of a count", () => {
    expect(press(normal("abc\ndef", 6), "0").caret).toBe(4);
  });
});

describe("paste", () => {
  it("inserts pasted text at the caret in insert mode", () => {
    const state = handleKey(initialState("ab"), { key: "Insert", paste: "XY" });
    expect(state.text).toBe("abXY");
  });

  it("multiline paste keeps its newlines", () => {
    const state = handleKey(initialState(""), { key: "Insert", paste: "a\nb" });
    expect(state.text).toBe("a\nb");
  });
});

describe("word motions at the edges", () => {
  it("w at the last word stops at the end rather than wrapping", () => {
    expect(press(normal("one two", 4), "w").caret).toBe(7);
  });

  it("b at the first word stops at zero", () => {
    expect(press(normal("one two", 1), "b").caret).toBe(0);
  });

  it("dw at the end of a line does not eat the newline", () => {
    expect(type(normal("one\ntwo", 0), "dw").text).toBe("\ntwo");
  });
});

describe("the normal-mode caret", () => {
  it("never sits past the last character, so the block cursor is visible", () => {
    // vim does not allow it either: normal mode rests *on* a character.
    const state = initialState("hello", "normal");
    expect(state.caret).toBe(4);
  });

  it("sits at zero in an empty buffer", () => {
    expect(initialState("", "normal").caret).toBe(0);
  });

  it("insert mode still opens at the end, ready to type", () => {
    expect(initialState("hello", "insert").caret).toBe(5);
  });

  it("leaving insert at the end steps back onto the last character", () => {
    const typed = type(initialState(""), "abc");
    expect(press(typed, "Escape").caret).toBe(2);
  });
});

const chord = (state: EditorState, key: string): EditorState =>
  handleKey(state, { key, ctrl: true });

describe("visual mode", () => {
  it("v enters visual and anchors where the caret was", () => {
    const state = press(normal("hello world", 2), "v");
    expect(state.mode).toBe("visual");
    expect(state.anchor).toBe(2);
  });

  it("v again leaves visual", () => {
    expect(press(press(normal("hello"), "v"), "v").mode).toBe("normal");
  });

  it("motions extend the selection rather than moving it", () => {
    const state = type(normal("hello world"), "vll");
    expect(state.anchor).toBe(0);
    expect(state.caret).toBe(2);
  });

  it("d deletes the selection inclusively", () => {
    expect(type(normal("hello"), "vlld").text).toBe("lo");
  });

  it("y yanks the selection and leaves the caret at its start", () => {
    const state = type(normal("hello world", 6), "vlllly");
    expect(state.register).toBe("world");
    expect(state.caret).toBe(6);
    expect(state.mode).toBe("normal");
  });

  it("c deletes the selection and starts insert", () => {
    const state = type(normal("hello"), "vlc");
    expect(state.text).toBe("llo");
    expect(state.mode).toBe("insert");
  });

  it("V selects whole lines regardless of the column", () => {
    expect(type(normal("one\ntwo\nthree", 5), "Vd").text).toBe("one\nthree");
  });

  it("V then j takes both lines", () => {
    expect(type(normal("one\ntwo\nthree"), "Vjd").text).toBe("three");
  });

  it("o swaps which end of the selection moves", () => {
    const state = type(normal("hello world"), "vllo");
    expect(state.caret).toBe(0);
    expect(state.anchor).toBe(2);
  });

  it("gv restores the last selection", () => {
    const yanked = type(normal("hello world"), "vlly");
    const state = type(yanked, "gv");
    expect(state.mode).toBe("visual");
    expect(state.anchor).toBe(0);
    expect(state.caret).toBe(2);
  });

  it("Escape leaves visual without touching the buffer", () => {
    const state = press(type(normal("hello"), "vll"), "Escape");
    expect(state.mode).toBe("normal");
    expect(state.anchor).toBeNull();
    expect(state.text).toBe("hello");
  });

  it("~ swaps the case of the selection", () => {
    expect(type(normal("hello"), "vll~").text).toBe("HELlo");
  });

  it("> indents the selected lines", () => {
    expect(type(normal("one\ntwo"), "Vj>").text).toBe("  one\n  two");
  });

  it("J joins the selected lines", () => {
    expect(type(normal("one\ntwo\nthree"), "VjJ").text).toBe("one two\nthree");
  });

  it("p replaces the selection with the register", () => {
    const yanked = type(normal("one\ntwo", 4), "vlly");
    const state = type({ ...yanked, caret: 0 }, "vllp");
    expect(state.text).toBe("two\ntwo");
  });
});

describe("text objects", () => {
  it("diw deletes the word under the caret", () => {
    expect(type(normal("hello big world", 6), "diw").text).toBe("hello  world");
  });

  it("daw takes the trailing space too", () => {
    expect(type(normal("hello big world", 6), "daw").text).toBe("hello world");
  });

  it("ciw leaves insert mode ready to retype", () => {
    const state = type(normal("hello world"), "ciw");
    expect(state.text).toBe(" world");
    expect(state.mode).toBe("insert");
  });

  it('di" takes what is inside the quotes', () => {
    expect(type(normal('say "hello there" now', 8), 'di"').text).toBe('say "" now');
  });

  it('da" takes the quotes as well', () => {
    expect(type(normal('say "hello" now', 6), 'da"').text).toBe("say  now");
  });

  it("di( works from inside the brackets", () => {
    expect(type(normal("call(a, b) end", 6), "di(").text).toBe("call() end");
  });

  it("da{ takes the braces", () => {
    expect(type(normal("x {a} y", 3), "da{").text).toBe("x  y");
  });

  it("dip takes the paragraph", () => {
    expect(type(normal("one\ntwo\n\nthree"), "dip").text).toBe("\nthree");
  });

  it("yiw fills the register without changing the text", () => {
    const state = type(normal("hello world", 6), "yiw");
    expect(state.register).toBe("world");
    expect(state.text).toBe("hello world");
  });

  it("viw selects the word", () => {
    const state = type(normal("hello world", 6), "viw");
    expect(state.mode).toBe("visual");
    expect(state.anchor).toBe(6);
    expect(state.caret).toBe(10);
  });

  it("nested brackets pick the innermost pair", () => {
    expect(type(normal("a(b(c)d)e", 4), "di(").text).toBe("a(b()d)e");
  });
});

describe("find on the line", () => {
  it("f jumps to the next occurrence", () => {
    expect(type(normal("hello world"), "fw").caret).toBe(6);
  });

  it("t stops before it", () => {
    expect(type(normal("hello world"), "tw").caret).toBe(5);
  });

  it("F searches backwards", () => {
    expect(type(normal("hello world", 10), "Fo").caret).toBe(7);
  });

  it("; repeats the last find", () => {
    expect(type(normal("a.b.c"), "f;;").caret).toBe(0);
    expect(type(normal("a.b.c"), "f.;").caret).toBe(3);
  });

  it(", repeats it the other way", () => {
    expect(type(normal("a.b.c"), "f.;,").caret).toBe(1);
  });

  it("never leaves the line", () => {
    expect(type(normal("abc\nxbc"), "fx").caret).toBe(0);
  });

  it("df deletes up to and including the character", () => {
    expect(type(normal("hello world"), "dfo").text).toBe(" world");
  });

  it("dt deletes up to it", () => {
    expect(type(normal("hello world"), "dto").text).toBe("o world");
  });
});

describe("repeat with .", () => {
  it("repeats a delete", () => {
    expect(type(normal("aaa bbb ccc"), "dw.").text).toBe("ccc");
  });

  it("repeats x", () => {
    expect(type(normal("hello"), "x.").text).toBe("llo");
  });

  it("repeats an insert session", () => {
    const typed = handleKey(type(normal("ab"), "iX"), { key: "Escape" });
    expect(press(typed, ".").text).toBe("XXab");
  });

  it("repeats a change with its typed text", () => {
    const changed = handleKey(type(normal("one two"), "ciwX"), { key: "Escape" });
    expect(changed.text).toBe("X two");
    expect(type(changed, "w.").text).toBe("X X");
  });

  it("keeps the count", () => {
    expect(type(normal("abcdefgh"), "2x.").text).toBe("efgh");
  });

  it("a motion is not part of the change it precedes", () => {
    // Had `w` been recorded, `.` would jump to the end before deleting.
    const state = type(normal("hello world"), "wx");
    expect(state.text).toBe("hello orld");
    expect(press(state, ".").text).toBe("hello rld");
  });
});

describe("registers", () => {
  it('"ay puts the yank in a named register', () => {
    const state = type(normal("hello world"), '"ayiw');
    expect(state.registers.a?.text).toBe("hello");
  });

  it('"ap pastes from it', () => {
    const yanked = type(normal("hello world"), '"ayiw');
    const state = type({ ...yanked, caret: 10 }, '"ap');
    expect(state.text).toBe("hello worldhello");
  });

  it("an unnamed yank does not disturb a named register", () => {
    const first = type(normal("hello world"), '"ayiw');
    const second = type({ ...first, caret: 6 }, "yiw");
    expect(second.registers.a?.text).toBe("hello");
    expect(second.register).toBe("world");
  });

  it("yy is linewise and pastes onto a new line", () => {
    const state = type(normal("one\ntwo"), "yyp");
    expect(state.text).toBe("one\none\ntwo");
  });
});

describe("in-buffer search", () => {
  const run = (state: EditorState, keys: string) =>
    handleKey(type(state, keys), { key: "Enter" });

  it("/ moves to the match", () => {
    expect(run(normal("alpha beta gamma"), "/beta").caret).toBe(6);
  });

  it("n goes to the next one", () => {
    expect(press(run(normal("aXbXc"), "/X"), "n").caret).toBe(3);
  });

  it("N goes back", () => {
    expect(press(press(run(normal("aXbXc"), "/X"), "n"), "N").caret).toBe(1);
  });

  it("wraps around the end", () => {
    expect(press(press(run(normal("aXbXc"), "/X"), "n"), "n").caret).toBe(1);
  });

  it("? searches backwards", () => {
    expect(run(normal("aXbXc", 4), "?X").caret).toBe(3);
  });

  it("a lowercase pattern ignores case", () => {
    expect(run(normal("hello World"), "/world").caret).toBe(6);
  });

  it("a pattern with a capital does not", () => {
    expect(run(normal("hello world"), "/World").caret).toBe(0);
  });

  it("Escape abandons the prompt", () => {
    const state = press(type(normal("hello"), "/hel"), "Escape");
    expect(state.promptKind).toBeNull();
    expect(state.caret).toBe(0);
  });

  it("typing into the prompt never reaches the buffer", () => {
    expect(type(normal("hello"), "/dd").text).toBe("hello");
  });
});

describe("ex commands", () => {
  const run = (state: EditorState, keys: string) =>
    handleKey(type(state, keys), { key: "Enter" });

  it(":w submits", () => {
    expect(run(normal("hi"), ":w").submit).toBe(true);
  });

  it(":wq submits", () => {
    expect(run(normal("hi"), ":wq").submit).toBe(true);
  });

  it(":q cancels", () => {
    expect(run(normal("hi"), ":q").cancel).toBe(true);
  });

  it("an unknown command is handed to the host", () => {
    expect(run(normal("hi"), ":attach").command).toBe("attach");
  });
});

describe("C-c chords", () => {
  it("C-c C-c submits like ZZ", () => {
    expect(chord(chord(normal("hi"), "c"), "c").submit).toBe(true);
  });

  it("C-c C-k discards like ZQ", () => {
    expect(chord(chord(normal("hi"), "c"), "k").cancel).toBe(true);
  });

  it("works from insert mode", () => {
    const inserting = type(normal("hi"), "iX");
    expect(chord(chord(inserting, "c"), "c").submit).toBe(true);
  });

  it("C-c followed by anything else acts as Escape", () => {
    const state = press(chord(type(normal("hi"), "i"), "c"), "j");
    expect(state.mode).toBe("normal");
    expect(state.submit).toBe(false);
  });
});

describe("small edits", () => {
  it("r replaces one character", () => {
    expect(type(normal("hello"), "rj").text).toBe("jello");
  });

  it("J joins two lines with a space", () => {
    expect(press(normal("one\ntwo"), "J").text).toBe("one two");
  });

  it("~ flips the case under the caret", () => {
    expect(press(normal("abc"), "~").text).toBe("Abc");
  });

  it("S replaces the whole line", () => {
    const state = type(normal("one\ntwo"), "S");
    expect(state.text).toBe("\ntwo");
    expect(state.mode).toBe("insert");
  });

  it(">> indents the line", () => {
    expect(type(normal("one"), ">>").text).toBe("  one");
  });

  it("<< removes the indent", () => {
    expect(type(normal("    one", 4), "<<").text).toBe("  one");
  });

  it("C-r redoes an undone change", () => {
    const undone = type(normal("hello"), "xu");
    expect(undone.text).toBe("hello");
    expect(chord(undone, "r").text).toBe("ello");
  });

  it("C-a increments the number under the caret", () => {
    expect(chord(normal("item 41", 5), "a").text).toBe("item 42");
  });

  it("C-x decrements it", () => {
    expect(chord(normal("item 42", 5), "x").text).toBe("item 41");
  });

  it("% jumps to the matching bracket", () => {
    expect(press(normal("call(a, b)"), "%").caret).toBe(9);
  });

  it("{ and } move by paragraph", () => {
    expect(press(normal("one\n\ntwo"), "}").caret).toBe(4);
  });
});

describe("single-line fields", () => {
  const field = (text: string) => ({ ...initialState(text, "normal", true), caret: 0 });

  it("Enter asks for the next field instead of breaking the line", () => {
    const state = press(type(field("alice"), "i"), "Enter");
    expect(state.text).toBe("alice");
    expect(state.next).toBe(true);
  });

  it("Tab asks for the next field", () => {
    expect(press(type(field("alice"), "i"), "Tab").next).toBe(true);
  });

  it("Shift-Tab asks for the previous one", () => {
    const state = handleKey(type(field("alice"), "i"), { key: "Tab", shift: true });
    expect(state.previous).toBe(true);
  });

  it("o cannot open a line", () => {
    const state = press(field("alice"), "o");
    expect(state.text).toBe("alice");
    expect(state.mode).toBe("insert");
  });

  it("a pasted newline becomes a space", () => {
    const state = handleKey(field("a"), { key: "Insert", paste: "b\nc" });
    expect(state.text).not.toContain("\n");
  });

  it("still takes the whole editing grammar", () => {
    expect(type(field("hello world"), "dw").text).toBe("world");
  });
});

describe("yanking reaches the host clipboard", () => {
  it("y fills the clipboard channel", () => {
    expect(type(normal("hello world"), "yiw").clipboard).toBe("hello");
  });

  it("a delete fills it too, as vim's unnamed register does", () => {
    expect(type(normal("hello world"), "dw").clipboard).toBe("hello ");
  });

  it("a motion leaves it alone", () => {
    expect(type(normal("hello"), "w").clipboard).toBeNull();
  });
});
