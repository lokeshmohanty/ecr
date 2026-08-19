/**
 * Bare URLs in a plain-text body become links, so Enter on one opens it just
 * as it does in the HTML view. Escaping happens here rather than by handing
 * the string to `innerHTML` raw.
 */
const URL_PATTERN = /\b(https?:\/\/[^\s<>"')\]]+|www\.[^\s<>"')\]]+)/gi;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/**
 * One pass, not four.
 *
 * This is called on the whole of a plain-text body, which for a converted HTML
 * message is tens of kilobytes, and four chained `replace` calls walk all of it
 * four times and allocate a fresh copy each time. The character class is also
 * the cheap path in every engine: a body with nothing to escape does one scan
 * and returns the string it was given.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ESCAPES[char]!);
}

export function linkify(text: string): string {
  let out = "";
  let at = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    const raw = match[0];

    // Trailing punctuation belongs to the sentence, not the address.
    const trimmed = raw.replace(/[.,;:!?]+$/, "");
    const href = trimmed.startsWith("www.") ? `https://${trimmed}` : trimmed;

    out += escapeHtml(text.slice(at, index));
    out += `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${escapeHtml(trimmed)}</a>`;
    at = index + trimmed.length;
  }

  return out + escapeHtml(text.slice(at));
}

/**
 * A markdown image or link, as the reading text writes one.
 *
 * One pattern for both, because they are the same shape and an image is a link
 * with a `!` in front: scanning for them separately means whichever ran second
 * saw the other's output, and `![alt](url)` would be found again as a link
 * called `!` plus a link called `alt`.
 *
 * Neither may cross a line. A sentence ending in `!` above an ordinary
 * `[link](url)` would otherwise be read as one image spanning the paragraph
 * between them, and a `[` in prose would swallow everything up to the next
 * parenthesis anywhere below it.
 */
const MARKUP_PATTERN = /(!?)\[([^\]\n]*)\]\(([^)\s]+)\)/g;

/**
 * What an image is allowed to point at.
 *
 * The server has already resolved `cid:` to a part of this message and
 * dropped, or kept, whatever was remote according to the reader's setting — so
 * by the time a target is here it is a URL that was meant to be fetched. This
 * is the second layer: the body is not markup and never reaches `innerHTML`
 * unescaped, but an `src` does, and `javascript:` is a scheme.
 *
 * `data:image/svg+xml` is refused with the rest. An `<img>` does not run
 * script in an SVG it loads, so it is safe by specification rather than by
 * construction, and nothing in mail needs it.
 */
const FETCHABLE = /^(?:https?:\/\/|\/(?!\/)|data:image\/(?!svg))/i;

/**
 * What a link is allowed to point at.
 *
 * Wider than `FETCHABLE`, because a link is followed on purpose and `mailto:`
 * is a thing a message legitimately says — `ui/follow-link.ts` turns one into
 * a composer. Narrower than everything, because the href reaches `innerHTML`
 * as an attribute and `javascript:` is a scheme.
 */
const FOLLOWABLE = /^(?:https?:\/\/|mailto:|\/(?!\/))/i;

/**
 * The plain-text body, rendered.
 *
 * It is markdown — the markup read as text, see `ecr_store::markdown` — and
 * for the most part reading it as text is the whole point: `# heading` and
 * `- item` are legible without anything rendering them, and rendering them
 * would make this a second HTML view rather than the flat one somebody chose.
 *
 * Images and links are the exceptions, and for one reason: they are the two
 * pieces of markdown punctuation that stand in for something rather than
 * decorating it. `![](https://…)` is not a legible way to read a picture, and
 * `[the notes](https://…/a/very/long/path)` is a sentence with a URL wedged
 * into the middle of it — while `linkify` had already been turning the *bare*
 * URLs beside them into anchors all along, so leaving these was the
 * inconsistency rather than the restraint.
 *
 * A target that is not a URL of a kind worth following is dropped back to the
 * words it was written with, which is all such a link ever said.
 */
export function renderBodyText(text: string): string {
  let out = "";
  let at = 0;

  for (const match of text.matchAll(MARKUP_PATTERN)) {
    const index = match.index ?? 0;
    const image = match[1] === "!";
    const label = match[2] ?? "";
    const target = match[3] ?? "";

    out += linkify(text.slice(at, index));

    if (image) {
      out += FETCHABLE.test(target)
        ? `<img class="body-image" src="${escapeHtml(target)}" alt="${escapeHtml(label)}" loading="lazy">`
        : escapeHtml(label);
    } else {
      out += FOLLOWABLE.test(target)
        ? `<a href="${escapeHtml(target)}" target="_blank" rel="noreferrer noopener">${escapeHtml(label || target)}</a>`
        : escapeHtml(match[0]);
    }

    at = index + match[0].length;
  }

  return out + linkify(text.slice(at));
}
