import { describe, expect, it } from "vitest";
import { overlayRuns } from "./overlay";

const joined = (text: string, caret: number, selection = null) =>
  overlayRuns(text, caret, selection)
    .map((r) => r.text)
    .join("");

describe("cursor overlay runs", () => {
  it("puts a one-character block under the caret", () => {
    expect(overlayRuns("hello", 1, null)).toEqual([
      { text: "h", kind: "plain" },
      { text: "e", kind: "cursor" },
      { text: "llo", kind: "plain" },
    ]);
  });

  it("blocks the first character when the caret is at zero", () => {
    expect(overlayRuns("hi", 0, null)[0]).toEqual({ text: "h", kind: "cursor" });
  });

  it("renders a synthetic block past the end of the buffer", () => {
    expect(overlayRuns("hi", 2, null)).toEqual([
      { text: "hi", kind: "plain" },
      { text: " ", kind: "cursor" },
    ]);
  });

  it("renders a synthetic block on an empty buffer", () => {
    expect(overlayRuns("", 0, null)).toEqual([{ text: " ", kind: "cursor" }]);
  });

  it("never paints the block on a line break", () => {
    const runs = overlayRuns("a\nb", 1, null);
    expect(runs).toEqual([
      { text: "a", kind: "plain" },
      { text: " ", kind: "cursor" },
      { text: "\nb", kind: "plain" },
    ]);
  });

  it("paints a selection around the cursor", () => {
    expect(overlayRuns("abcdef", 3, { from: 1, to: 5 })).toEqual([
      { text: "a", kind: "plain" },
      { text: "bc", kind: "selection" },
      { text: "d", kind: "cursor" },
      { text: "e", kind: "selection" },
      { text: "f", kind: "plain" },
    ]);
  });

  it("keeps the cursor visible at the head of a selection", () => {
    expect(overlayRuns("abcdef", 1, { from: 1, to: 4 })).toEqual([
      { text: "a", kind: "plain" },
      { text: "b", kind: "cursor" },
      { text: "cd", kind: "selection" },
      { text: "ef", kind: "plain" },
    ]);
  });

  it("preserves every character of the buffer", () => {
    expect(joined("hello world", 4)).toBe("hello world");
    expect(joined("one\ntwo", 5)).toBe("one\ntwo");
  });

  it("merges adjacent runs of the same kind", () => {
    const runs = overlayRuns("abcdef", 0, { from: 4, to: 6 });
    expect(runs.filter((r) => r.kind === "plain")).toHaveLength(1);
  });

  it("clamps a caret past the end", () => {
    expect(() => overlayRuns("hi", 99, null)).not.toThrow();
    expect(joined("hi", 99)).toBe("hi ");
  });
});
