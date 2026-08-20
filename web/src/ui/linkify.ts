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
