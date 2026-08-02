import { describe, expect, it } from "vitest";
import { runCommand } from "./Palette";
import { formatRecipients, nextField, parseRecipients } from "./ComposePane";

describe("command grammar", () => {
  it("maps view shortcuts to notmuch queries", () => {
    expect(runCommand("inbox").query).toBe("tag:inbox");
    expect(runCommand("unread").query).toBe("tag:unread");
    expect(runCommand("flagged").query).toBe("tag:flagged");
    expect(runCommand("all").query).toBe("*");
  });

  it("passes a search argument through verbatim", () => {
    expect(runCommand("search from:alice and tag:inbox").query).toBe(
      "from:alice and tag:inbox",
    );
  });

  it("accepts short aliases", () => {
    expect(runCommand("s from:bob").query).toBe("from:bob");
    expect(runCommand("q").quit).toBe(true);
    expect(runCommand("w").sync).toBe(true);
  });

  it("reports usage when search has no argument", () => {
    expect(runCommand("search").status).toMatch(/usage/);
  });

  it("takes the name a query is saved under, spaces and all", () => {
    expect(runCommand("save Work threads").save).toBe("Work threads");
  });

  it("reports usage when save has no name", () => {
    expect(runCommand("save").status).toMatch(/usage/);
    expect(runCommand("save").save).toBeUndefined();
  });

  it("reports unknown commands rather than failing silently", () => {
    expect(runCommand("frobnicate").status).toMatch(/unknown command/);
  });

  it("treats an empty command as a no-op", () => {
    expect(runCommand("   ")).toEqual({});
  });

  it("tolerates extra whitespace", () => {
    expect(runCommand("  inbox  ").query).toBe("tag:inbox");
  });
});

describe("recipient parsing", () => {
  it("splits on commas and trims", () => {
    expect(parseRecipients("a@x.com, b@y.com ,c@z.com")).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
  });

  it("drops empty entries from trailing commas", () => {
    expect(parseRecipients("a@x.com, ,")).toEqual(["a@x.com"]);
  });

  it("returns nothing for an empty field", () => {
    expect(parseRecipients("")).toEqual([]);
    expect(parseRecipients("   ")).toEqual([]);
  });

  it("round-trips through formatting", () => {
    const list = ["a@x.com", "b@y.com"];
    expect(parseRecipients(formatRecipients(list))).toEqual(list);
  });
});

describe("walking the composer's fields", () => {
  it("Tab goes to the next one", () => {
    expect(nextField("to", 1)).toBe("cc");
    expect(nextField("subject", 1)).toBe("body");
  });

  it("Shift-Tab goes back", () => {
    expect(nextField("cc", -1)).toBe("to");
  });

  it("wraps at both ends, so no field is a dead end", () => {
    expect(nextField("body", 1)).toBe("to");
    expect(nextField("to", -1)).toBe("body");
  });
});
