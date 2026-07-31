import { describe, expect, it } from "vitest";
import { runCommand } from "./Palette";
import { draftFromText, draftToText, formatRecipients, parseRecipients } from "./ComposePane";

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

describe("draft as text", () => {
  const base = {
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "",
    in_reply_to: null,
    references: [],
  };

  it("round-trips headers and body", () => {
    const draft = {
      ...base,
      to: ["a@x.com"],
      cc: ["b@y.com"],
      subject: "Hello",
      body: "Line one\nLine two",
    };
    expect(draftFromText(draftToText(draft), base)).toEqual(draft);
  });

  it("keeps threading headers that are not shown in the text", () => {
    const reply = { ...base, in_reply_to: "orig@x", references: ["orig@x"] };
    const parsed = draftFromText(draftToText(reply), reply);
    expect(parsed.in_reply_to).toBe("orig@x");
    expect(parsed.references).toEqual(["orig@x"]);
  });

  it("treats everything after the blank line as body, including blank lines", () => {
    const parsed = draftFromText("To: a@x.com\n\nfirst\n\nthird", base);
    expect(parsed.body).toBe("first\n\nthird");
  });

  it("is case-insensitive about header names", () => {
    expect(draftFromText("to: a@x.com\nSUBJECT: Hi\n\nbody", base).to).toEqual(["a@x.com"]);
    expect(draftFromText("to: a@x.com\nSUBJECT: Hi\n\nbody", base).subject).toBe("Hi");
  });

  it("survives a subject containing a colon", () => {
    expect(draftFromText("To: a@x.com\nSubject: Re: a: b\n\nbody", base).subject).toBe("Re: a: b");
  });

  it("yields no recipients when the header is empty", () => {
    expect(draftFromText("To: \nSubject: Hi\n\nbody", base).to).toEqual([]);
  });
});
