/**
 * A vim cursor over rendered DOM, used for reading a message rather than
 * editing one.
 *
 * The message frame is sandboxed without `allow-scripts` and stays that way:
 * nothing here runs inside it. The parent walks `contentDocument` — which
 * `allow-same-origin` already permits, and which the frame's own resize
 * measurement already relies on — flattens it to a string, runs the ordinary
 * motions over that string, and paints the result with the document's own
 * selection. The same code drives the `<pre>` of a plain-text message, so both
 * views behave identically.
 */

export interface Segment {
  node: Text;
  /** Where this segment's text begins in the flat buffer. */
  start: number;
  text: string;
  /** For each character, its offset in the original node. */
  offsets: number[];
}

export interface Flat {
  text: string;
  segments: Segment[];
}

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "HEAD", "TITLE", "TEMPLATE"]);

/** Elements that start a new line in the flat buffer, so j/k have lines to move by. */
const BLOCK = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "CAPTION", "DD", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY",
  "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

/** CSS collapses runs of whitespace; the flat buffer has to agree or the cursor drifts. */
function collapse(raw: string): { text: string; offsets: number[] } {
  const characters: string[] = [];
  const offsets: number[] = [];
  let blank = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (/\s/.test(char)) {
      if (blank) continue;
      blank = true;
      characters.push(" ");
    } else {
      blank = false;
      characters.push(char);
    }
    offsets.push(i);
  }
  return { text: characters.join(""), offsets };
}

function verbatim(raw: string): { text: string; offsets: number[] } {
  return { text: raw, offsets: raw.split("").map((_, i) => i) };
}

function hidden(element: Element): boolean {
  if (element.hasAttribute("hidden")) return true;
  const view = element.ownerDocument.defaultView;
  if (!view?.getComputedStyle) return false;
  try {
    const style = view.getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden";
  } catch {
    return false;
  }
}

function preformatted(element: Element): boolean {
  if (element.tagName === "PRE") return true;
  const view = element.ownerDocument.defaultView;
  if (!view?.getComputedStyle) return false;
  try {
    return view.getComputedStyle(element).whiteSpace.startsWith("pre");
  } catch {
    return false;
  }
}

export function flatten(root: Element): Flat {
  const segments: Segment[] = [];
  let text = "";

  const breakLine = () => {
    if (text !== "" && !text.endsWith("\n")) text += "\n";
  };

  const walk = (node: Node, pre: boolean) => {
    if (node.nodeType === 3) {
      const raw = (node as Text).data;
      if (raw === "") return;

      const piece = pre ? verbatim(raw) : collapse(raw);
      let { text: value } = piece;
      const { offsets } = piece;

      // A space at the head of a line is not rendered, so it is not in the buffer.
      if (!pre && value.startsWith(" ") && (text === "" || text.endsWith("\n"))) {
        value = value.slice(1);
        offsets.shift();
      }
      if (value === "") return;

      segments.push({ node: node as Text, start: text.length, text: value, offsets });
      text += value;
      return;
    }

    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (SKIP.has(element.tagName) || hidden(element)) return;

    const block = BLOCK.has(element.tagName);
    const inPre = pre || preformatted(element);
    if (block) breakLine();

    for (const child of [...element.childNodes]) walk(child, inPre);

    if (block) breakLine();
  };

  walk(root, false);
  return { text, segments };
}

/** The node and offset a flat index points at. */
export function locate(flat: Flat, index: number): { node: Text; offset: number } | null {
  if (flat.segments.length === 0) return null;

  let best: Segment | null = null;
  for (const segment of flat.segments) {
    if (segment.start > index) break;
    best = segment;
  }
  if (!best) best = flat.segments[0]!;

  const within = index - best.start;
  if (within >= best.text.length) {
    // A synthetic line break between blocks: settle on the end of the last real text.
    const last = best.offsets.at(-1);
    return { node: best.node, offset: last === undefined ? 0 : last + 1 };
  }
  return { node: best.node, offset: best.offsets[Math.max(within, 0)] ?? 0 };
}

/** The flat index a DOM position corresponds to, for click and hit-testing. */
export function indexOfNode(flat: Flat, node: Node, offset: number): number | null {
  for (const segment of flat.segments) {
    if (segment.node !== node) continue;
    for (let i = 0; i < segment.offsets.length; i++) {
      if (segment.offsets[i]! >= offset) return segment.start + i;
    }
    return segment.start + segment.text.length - 1;
  }
  return null;
}

export function rangeFor(flat: Flat, from: number, to: number): Range | null {
  const start = locate(flat, from);
  const end = locate(flat, Math.max(to - 1, from));
  if (!start || !end) return null;

  const doc = start.node.ownerDocument;
  if (!doc) return null;

  const range = doc.createRange();
  try {
    range.setStart(start.node, Math.min(start.offset, start.node.data.length));
    range.setEnd(end.node, Math.min(end.offset + 1, end.node.data.length));
  } catch {
    return null;
  }
  return range;
}

/** The href of the link under a flat index, if there is one. */
export function linkAt(flat: Flat, index: number): string | null {
  const at = locate(flat, index);
  if (!at) return null;

  let element: Element | null = at.node.parentElement;
  while (element) {
    if (element.tagName === "A") {
      const href = element.getAttribute("href");
      if (href && !href.startsWith("javascript:")) return href;
    }
    element = element.parentElement;
  }
  return null;
}

/**
 * The index at a point, for click-to-place and for vertical motion. The
 * standard spelling is `caretPositionFromPoint`; WebKit and older Chrome only
 * have `caretRangeFromPoint`.
 */
export function indexFromPoint(flat: Flat, doc: Document, x: number, y: number): number | null {
  const legacy = doc as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const modern = doc as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };

  if (typeof modern.caretPositionFromPoint === "function") {
    const position = modern.caretPositionFromPoint(x, y);
    return position ? indexOfNode(flat, position.offsetNode, position.offset) : null;
  }
  if (typeof legacy.caretRangeFromPoint === "function") {
    const range = legacy.caretRangeFromPoint(x, y);
    return range ? indexOfNode(flat, range.startContainer, range.startOffset) : null;
  }
  return null;
}

/**
 * Vertical motion by rendered line rather than by buffer line: a paragraph of
 * wrapped HTML is one line in the flat buffer but many on screen, so `j` has
 * to follow what the reader sees.
 */
export function verticalFromRect(
  flat: Flat,
  doc: Document,
  caret: number,
  direction: 1 | -1,
): number | null {
  const range = rangeFor(flat, caret, caret + 1);
  if (!range) return null;

  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;

  const step = Math.max(rect.height, 8);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const y = direction === 1 ? rect.bottom + step * attempt - step / 2 : rect.top - step * (attempt - 0.5);
    const found = indexFromPoint(flat, doc, rect.left + 1, y);
    if (found !== null && found !== caret) return found;
  }
  return null;
}

const STYLE_ID = "ecr-cursor-style";

/** The block cursor is the document's own selection, restyled to read as one. */
export function installCursorStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;

  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `::selection { background: #7c5cff; color: #ffffff; }`;
  (doc.head ?? doc.documentElement)?.appendChild(style);
}

export function paint(doc: Document, range: Range | null): void {
  const selection = doc.getSelection?.();
  if (!selection) return;

  selection.removeAllRanges();
  if (range) selection.addRange(range);
}
