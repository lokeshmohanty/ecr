import { describe, expect, it } from "vitest";
import { linkify } from "./linkify";
import { renderMarkdown } from "./markdown";

describe("rendering images and links", () => {
  it("turns a markdown image into the image", () => {
    const out = renderMarkdown("before ![a cat](https://example.com/cat.png) after");
    expect(out).toContain('<img class="body-image" src="https://example.com/cat.png"');
    expect(out).toContain('alt="a cat"');
    expect(out).not.toContain("![");
  });

  it("renders a part url the server resolved cid: to", () => {
    const out = renderMarkdown("![logo](/api/v1/messages/x@y/parts/2)");
    expect(out).toContain('src="/api/v1/messages/x@y/parts/2"');
  });

  /* The one target that reaches `innerHTML` as an attribute rather than text. */
  it("refuses a scheme that is not a way of fetching a picture", () => {
    for (const src of ["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4="]) {
      const out = renderMarkdown(`![x](${src})`);
      expect(out, src).not.toContain("<img");
      // What is left is the alt text, which is all such an image ever said.
      expect(out, src).toContain("x");
      expect(out, src).not.toContain(src);
    }
  });

  it("escapes a target that tries to close the tag", () => {
    const out = renderMarkdown('![x](https://example.com/"onerror="alert(1))');
    expect(out).not.toContain('onerror="alert(1)"');
  });

  /* A sentence ending in `!` above an ordinary link is not one image. */
  it("does not read an image across a line break", () => {
    const text = "Look at this![\n\nread the notes](https://example.com/x)";
    const out = renderMarkdown(text);
    expect(out).not.toContain("<img");
    expect(out).toContain("<a ");
  });

  it("still linkifies the prose around an image", () => {
    const out = renderMarkdown("![](https://example.com/p.gif) see https://example.com/x");
    expect(out.match(/<img /g)).toHaveLength(1);
    expect(out.match(/<a /g)).toHaveLength(1);
  });

  /* Prose with no marks in it is prose, and must come through untouched. */
  it("leaves a body with nothing to render exactly as linkify left it", () => {
    const text = "Just a sentence.\n\nAnd another, see https://example.com";
    expect(renderMarkdown(text)).toBe(linkify(text));
  });

  it("turns a markdown link into an anchor over its own words", () => {
    const out = renderMarkdown("See [the notes](https://example.com/a/long/path).");
    expect(out).toContain('href="https://example.com/a/long/path"');
    expect(out).toContain(">the notes</a>");
    expect(out).not.toContain("](");
  });

  /* `follow-link.ts` turns one of these into a composer. */
  it("follows a mailto, which is a thing a message legitimately says", () => {
    expect(renderMarkdown("[write](mailto:a@example.com)")).toContain(
      'href="mailto:a@example.com"',
    );
  });

  /*
   * Left as the text it was written as, rather than reduced to its words the
   * way a refused image is: a reader who is being shown something odd is
   * better off seeing where it claimed to point, and it cannot be clicked.
   */
  it("refuses a link scheme that is not a way of going somewhere", () => {
    const out = renderMarkdown("[click](javascript:alert(1))");
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("href");
    expect(out).toContain("[click]");
  });

  /* One scan for both, or whichever ran second finds the other's output. */
  it("does not read an image as a link with an exclamation beside it", () => {
    const out = renderMarkdown("![a cat](https://example.com/cat.png)");
    expect(out.match(/<img /g)).toHaveLength(1);
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("!");
  });

  it("keeps a link whose words are empty pointing at something readable", () => {
    expect(renderMarkdown("[](https://example.com/x)")).toContain(
      ">https://example.com/x</a>",
    );
  });
});

describe("rendering the marks the converter emits", () => {
  it("renders bold and italic as bold and italic", () => {
    const out = renderMarkdown("Rich **HTML** body, *really*");
    expect(out).toBe("Rich <strong>HTML</strong> body, <em>really</em>");
  });

  it("renders a code span without touching what is inside it", () => {
    expect(renderMarkdown("run `a **b** c`")).toBe(
      "run <code>a **b** c</code>",
    );
  });

  /* A heading is the marks doing work; the hashes are not part of the words. */
  it("renders a heading and drops its hashes", () => {
    expect(renderMarkdown("## Notice")).toBe(
      '<span class="md-h md-h2">Notice</span>',
    );
  });

  it("sets a list marker apart without removing it", () => {
    const out = renderMarkdown("- first\n1. second");
    expect(out).toContain('<span class="md-marker">-</span> first');
    expect(out).toContain('<span class="md-marker">1.</span> second');
  });

  it("keeps a quote's marker, which is all that says where it ends", () => {
    expect(renderMarkdown("> quoted")).toContain('<span class="md-quote">&gt; quoted');
  });

  it("draws a rule rather than printing its asterisks", () => {
    expect(renderMarkdown("* * *")).toBe(
      '<span class="md-rule" aria-hidden="true"></span>',
    );
  });

  it("takes a fenced block literally, marks and all", () => {
    const out = renderMarkdown("before\n```\nlet a = **b**;\n```\nafter");
    expect(out).toContain('<code class="md-fence">let a = **b**;</code>');
    expect(out).not.toContain("<strong>");
  });

  /* A fence that never closes is a truncated message, not licence to drop the rest. */
  it("closes a fence nobody closed", () => {
    expect(renderMarkdown("```\nstill here")).toContain("still here");
  });

  it("does not read multiplication as emphasis", () => {
    expect(renderMarkdown("2 * 3 * 4")).toBe("2 * 3 * 4");
  });

  it("does not read a bullet as an opening delimiter", () => {
    expect(renderMarkdown("* an item")).toContain('<span class="md-marker">*</span>');
  });

  it("nests emphasis inside emphasis", () => {
    expect(renderMarkdown("**bold and *both* **")).toContain("<em>both</em>");
  });

  it("still escapes everything it does not render", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("keeps a line a line, so view mode still moves by one", () => {
    const out = renderMarkdown("**one**\n*two*");
    expect(out.split("\n")).toHaveLength(2);
  });

  /* A bare URL as a link's own words would be a second anchor inside the first. */
  it("never nests one anchor inside another", () => {
    const out = renderMarkdown("[](https://example.com/x)");
    expect(out.match(/<a /g)).toHaveLength(1);
  });
});
