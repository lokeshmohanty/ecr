import { describe, expect, it } from "vitest";
import { escapeHtml, linkify } from "./linkify";

describe("linkifying a plain-text body", () => {
  it("wraps a bare url", () => {
    expect(linkify("see https://example.com now")).toBe(
      'see <a href="https://example.com" target="_blank" rel="noreferrer noopener">https://example.com</a> now',
    );
  });

  it("gives a www address a scheme", () => {
    expect(linkify("www.example.com")).toContain('href="https://www.example.com"');
  });

  it("leaves the sentence's punctuation out of the link", () => {
    const out = linkify("go to https://example.com/x.");
    expect(out).toContain(">https://example.com/x</a>.");
  });

  it("handles several links in one line", () => {
    const out = linkify("a https://one.test b http://two.test c");
    expect(out.match(/<a /g)).toHaveLength(2);
  });

  it("escapes html in the surrounding text", () => {
    expect(linkify("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes html inside a url", () => {
    expect(linkify('https://example.com/"><img')).not.toContain('"><img');
  });

  it("never emits a javascript url as a link", () => {
    expect(linkify("javascript:alert(1)")).not.toContain("<a ");
  });

  it("leaves text with no url alone", () => {
    expect(linkify("nothing to see")).toBe("nothing to see");
  });

  it("escapes ampersands so entities cannot be smuggled in", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });
});
