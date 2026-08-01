// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { flatten, indexOfNode, linkAt, locate, rangeFor } from "./doc-cursor";

function build(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("flattening rendered html", () => {
  it("reads the text out in order", () => {
    expect(flatten(build("<p>one</p><p>two</p>")).text).toBe("one\ntwo\n");
  });

  it("puts a line break between blocks so j and k have lines", () => {
    const flat = flatten(build("<div>a</div><div>b</div>"));
    expect(flat.text.split("\n").filter(Boolean)).toEqual(["a", "b"]);
  });

  it("keeps inline elements on one line", () => {
    expect(flatten(build("<p>hello <b>big</b> world</p>")).text.trim()).toBe("hello big world");
  });

  it("collapses the whitespace html would collapse", () => {
    expect(flatten(build("<p>one    two\n\n  three</p>")).text.trim()).toBe("one two three");
  });

  it("keeps whitespace inside pre", () => {
    expect(flatten(build("<pre>a    b</pre>")).text).toContain("a    b");
  });

  it("never reads script or style content", () => {
    const flat = flatten(build("<style>p{color:red}</style><script>alert(1)</script><p>hi</p>"));
    expect(flat.text).not.toContain("color");
    expect(flat.text).not.toContain("alert");
    expect(flat.text.trim()).toBe("hi");
  });

  it("skips hidden elements", () => {
    expect(flatten(build("<p hidden>gone</p><p>here</p>")).text.trim()).toBe("here");
  });

  it("treats br as a line break", () => {
    expect(flatten(build("<p>a<br>b</p>")).text.trim()).toBe("a\nb");
  });

  it("gives table cells their own lines", () => {
    const flat = flatten(build("<table><tr><td>a</td><td>b</td></tr></table>"));
    expect(flat.text.split("\n").filter(Boolean)).toEqual(["a", "b"]);
  });

  it("produces nothing for an empty document", () => {
    expect(flatten(build("")).text).toBe("");
  });
});

describe("mapping between the buffer and the dom", () => {
  it("locates a character in its own text node", () => {
    const root = build("<p>hello</p>");
    const flat = flatten(root);
    const at = locate(flat, 1);

    expect(at?.node.data).toBe("hello");
    expect(at?.offset).toBe(1);
  });

  it("locates a character in the second block", () => {
    const root = build("<p>one</p><p>two</p>");
    const flat = flatten(root);
    const at = locate(flat, flat.text.indexOf("two"));

    expect(at?.node.data).toBe("two");
    expect(at?.offset).toBe(0);
  });

  it("survives collapsed whitespace", () => {
    const root = build("<p>a     b</p>");
    const flat = flatten(root);
    // The buffer reads "a b"; the b is at offset 6 in the node.
    expect(flat.text.trim()).toBe("a b");
    expect(locate(flat, 2)?.offset).toBe(6);
  });

  it("round-trips a dom position back to an index", () => {
    const root = build("<p>one</p><p>two</p>");
    const flat = flatten(root);
    const node = flat.segments[1]!.node;

    expect(indexOfNode(flat, node, 1)).toBe(flat.text.indexOf("two") + 1);
  });

  it("builds a range covering one character", () => {
    const root = build("<p>hello</p>");
    document.body.appendChild(root);
    const flat = flatten(root);
    const range = rangeFor(flat, 1, 2);

    expect(range?.toString()).toBe("e");
    root.remove();
  });

  it("builds a range spanning several nodes", () => {
    const root = build("<p>ab</p><p>cd</p>");
    document.body.appendChild(root);
    const flat = flatten(root);
    const range = rangeFor(flat, 0, flat.text.indexOf("cd") + 2);

    expect(range?.toString()).toContain("ab");
    expect(range?.toString()).toContain("cd");
    root.remove();
  });

  it("returns nothing for an empty buffer rather than throwing", () => {
    expect(locate(flatten(build("")), 0)).toBeNull();
    expect(rangeFor(flatten(build("")), 0, 1)).toBeNull();
  });
});

describe("links under the cursor", () => {
  it("finds the href of the link the cursor is on", () => {
    const root = build('<p>see <a href="https://example.com">this</a> now</p>');
    const flat = flatten(root);

    expect(linkAt(flat, flat.text.indexOf("this"))).toBe("https://example.com");
  });

  it("finds a link wrapped in other inline elements", () => {
    const root = build('<a href="https://x.test"><b><i>deep</i></b></a>');
    const flat = flatten(root);

    expect(linkAt(flat, flat.text.indexOf("deep"))).toBe("https://x.test");
  });

  it("is null off a link", () => {
    const root = build('<p>plain <a href="https://x.test">link</a></p>');
    const flat = flatten(root);

    expect(linkAt(flat, 0)).toBeNull();
  });

  it("refuses a javascript url", () => {
    const root = build('<a href="javascript:alert(1)">click</a>');
    const flat = flatten(root);

    expect(linkAt(flat, 0)).toBeNull();
  });

  it("ignores an anchor with no href", () => {
    expect(linkAt(flatten(build("<a>name</a>")), 0)).toBeNull();
  });
});
