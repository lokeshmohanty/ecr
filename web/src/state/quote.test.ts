import { describe, expect, it } from "vitest";
import { quoteBody, replyAttribution } from "./quote";

describe("quoting a message body", () => {
  it("prefixes every line", () => {
    expect(quoteBody("one\ntwo")).toBe("> one\n> two");
  });

  it("keeps blank lines as bare markers rather than trailing spaces", () => {
    expect(quoteBody("one\n\ntwo")).toBe("> one\n>\n> two");
  });

  it("nests an existing quote without adding a space", () => {
    expect(quoteBody("> already")).toBe(">> already");
  });

  it("drops a trailing newline so the draft does not gain a blank quote line", () => {
    expect(quoteBody("one\n")).toBe("> one");
  });

  it("returns nothing for an empty body", () => {
    expect(quoteBody("")).toBe("");
    expect(quoteBody("   \n  ")).toBe("");
  });

  it("caps a very long body so a reply stays editable", () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const quoted = quoteBody(long);

    // 100 quoted lines plus a blank marker and the elision notice.
    expect(quoted.split("\n").length).toBeLessThanOrEqual(102);
    expect(quoted).toContain("[…]");
  });

  it("strips carriage returns so quoted mail does not gain ^M", () => {
    expect(quoteBody("one\r\ntwo")).toBe("> one\n> two");
  });
});

describe("the attribution line", () => {
  it("names the sender and the date", () => {
    expect(replyAttribution("Wed, 01 Apr 2026 14:00:00 +0000", "a@b.c")).toBe(
      "On Wed, 01 Apr 2026 14:00:00 +0000, a@b.c wrote:",
    );
  });

  it("copes with a missing sender", () => {
    expect(replyAttribution("Wed, 01 Apr 2026", null)).toBe("On Wed, 01 Apr 2026, someone wrote:");
  });

  it("copes with a missing date", () => {
    expect(replyAttribution("", "a@b.c")).toBe("a@b.c wrote:");
  });
});
