import { describe, expect, it } from "vitest";
import { effectiveFormat, toggleLabel, toggled } from "./format";

describe("which format a message is shown in", () => {
  it("follows the preference when nothing is overridden", () => {
    expect(effectiveFormat(undefined, true)).toBe("html");
    expect(effectiveFormat(undefined, false)).toBe("text");
  });

  it("an override wins over the preference", () => {
    expect(effectiveFormat("text", true)).toBe("text");
    expect(effectiveFormat("html", false)).toBe("html");
  });
});

describe("toggling", () => {
  it("switches away from the preference on the first press", () => {
    expect(toggled(undefined, true)).toBe("text");
    // The regression: with plain text preferred, pressing t must give html.
    expect(toggled(undefined, false)).toBe("html");
  });

  it("switches back on the second press", () => {
    expect(toggled("html", false)).toBe("text");
    expect(toggled("text", true)).toBe("html");
  });

  it("round-trips from either preference", () => {
    for (const preferHtml of [true, false]) {
      const once = toggled(undefined, preferHtml);
      const twice = toggled(once, preferHtml);
      expect(twice, `preferHtml=${preferHtml}`).toBe(effectiveFormat(undefined, preferHtml));
    }
  });
});

describe("the toggle's label", () => {
  it("names what pressing it will do, not the current state", () => {
    expect(toggleLabel("html")).toContain("plain text");
    expect(toggleLabel("text")).toContain("html");
  });

  it("mentions the key", () => {
    expect(toggleLabel("html")).toContain("t");
  });
});
