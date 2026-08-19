import { describe, expect, it } from "vitest";
import { escapeHtml, linkify, renderBodyText } from "./linkify";

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

describe("rendering the plain-text body", () => {
  it("turns a markdown image into the image", () => {
    const out = renderBodyText("before ![a cat](https://example.com/cat.png) after");
    expect(out).toContain('<img class="body-image" src="https://example.com/cat.png"');
    expect(out).toContain('alt="a cat"');
    expect(out).not.toContain("![");
  });

  it("renders a part url the server resolved cid: to", () => {
    const out = renderBodyText("![logo](/api/v1/messages/x@y/parts/2)");
    expect(out).toContain('src="/api/v1/messages/x@y/parts/2"');
  });

  /* The one target that reaches `innerHTML` as an attribute rather than text. */
  it("refuses a scheme that is not a way of fetching a picture", () => {
    for (const src of ["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4="]) {
      const out = renderBodyText(`![x](${src})`);
      expect(out, src).not.toContain("<img");
      // What is left is the alt text, which is all such an image ever said.
      expect(out, src).toContain("x");
      expect(out, src).not.toContain(src);
    }
  });

  it("escapes a target that tries to close the tag", () => {
    const out = renderBodyText('![x](https://example.com/"onerror="alert(1))');
    expect(out).not.toContain('onerror="alert(1)"');
  });

  /* A sentence ending in `!` above an ordinary link is not one image. */
  it("does not read an image across a line break", () => {
    const text = "Look at this![\n\nread the notes](https://example.com/x)";
    const out = renderBodyText(text);
    expect(out).not.toContain("<img");
    expect(out).toContain("<a ");
  });

  it("still linkifies the prose around an image", () => {
    const out = renderBodyText("![](https://example.com/p.gif) see https://example.com/x");
    expect(out.match(/<img /g)).toHaveLength(1);
    expect(out.match(/<a /g)).toHaveLength(1);
  });

  it("leaves a body with no images or links exactly as linkify left it", () => {
    const text = "# Heading\n\n- one\n- two\n\nsee https://example.com";
    expect(renderBodyText(text)).toBe(linkify(text));
  });

  it("turns a markdown link into an anchor over its own words", () => {
    const out = renderBodyText("See [the notes](https://example.com/a/long/path).");
    expect(out).toContain('href="https://example.com/a/long/path"');
    expect(out).toContain(">the notes</a>");
    expect(out).not.toContain("](");
  });

  /* `follow-link.ts` turns one of these into a composer. */
  it("follows a mailto, which is a thing a message legitimately says", () => {
    expect(renderBodyText("[write](mailto:a@example.com)")).toContain(
      'href="mailto:a@example.com"',
    );
  });

  /*
   * Left as the text it was written as, rather than reduced to its words the
   * way a refused image is: a reader who is being shown something odd is
   * better off seeing where it claimed to point, and it cannot be clicked.
   */
  it("refuses a link scheme that is not a way of going somewhere", () => {
    const out = renderBodyText("[click](javascript:alert(1))");
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("href");
    expect(out).toContain("[click]");
  });

  /* One scan for both, or whichever ran second finds the other's output. */
  it("does not read an image as a link with an exclamation beside it", () => {
    const out = renderBodyText("![a cat](https://example.com/cat.png)");
    expect(out.match(/<img /g)).toHaveLength(1);
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("!");
  });

  it("keeps a link whose words are empty pointing at something readable", () => {
    expect(renderBodyText("[](https://example.com/x)")).toContain(
      ">https://example.com/x</a>",
    );
  });
});
