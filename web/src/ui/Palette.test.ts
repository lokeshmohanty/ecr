import { describe, expect, it } from "vitest";
import { runCommand } from "./Palette";
import { parseRecipients, formatRecipients } from "./Compose";

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
