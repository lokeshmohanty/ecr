/**
 * Motions and text objects over a flat string. Nothing here knows about modes,
 * registers or the DOM, which is what lets the same grammar drive both the
 * editor and the read-only cursor the detail pane runs over a rendered message.
 */

const WORD = /[A-Za-z0-9_]/;
const BLANK = /\s/;

export interface Span {
  from: number;
  to: number;
}

export function lineStart(text: string, caret: number): number {
  const before = text.lastIndexOf("\n", Math.max(caret - 1, 0));
  return caret === 0 ? 0 : before + 1;
}

export function lineEnd(text: string, caret: number): number {
  const next = text.indexOf("\n", caret);
  return next === -1 ? text.length : next;
}

export function firstNonBlank(text: string, caret: number): number {
  const start = lineStart(text, caret);
  const end = lineEnd(text, caret);
  let i = start;
  while (i < end && BLANK.test(text[i]!)) i++;
  return i;
}

export function up(text: string, caret: number): number {
  const start = lineStart(text, caret);
  if (start === 0) return caret;
  const column = caret - start;
  const prevStart = lineStart(text, start - 1);
  return Math.min(prevStart + column, start - 1);
}

export function down(text: string, caret: number): number {
  const end = lineEnd(text, caret);
  if (end === text.length) return caret;
  const column = caret - lineStart(text, caret);
  const nextStart = end + 1;
  return Math.min(nextStart + column, lineEnd(text, nextStart));
}

/** Word characters, punctuation and whitespace are three classes, as in vim. */
function classOf(char: string, big: boolean): number {
  if (BLANK.test(char)) return 0;
  if (big) return 1;
  return WORD.test(char) ? 1 : 2;
}

export function wordForward(text: string, caret: number, big = false): number {
  let i = caret;
  const start = i < text.length ? classOf(text[i]!, big) : 0;
  if (start !== 0) while (i < text.length && classOf(text[i]!, big) === start) i++;
  while (i < text.length && classOf(text[i]!, big) === 0) i++;
  return i;
}

export function wordBack(text: string, caret: number, big = false): number {
  let i = caret - 1;
  while (i > 0 && classOf(text[i]!, big) === 0) i--;
  if (i <= 0) return Math.max(i, 0);

  const kind = classOf(text[i]!, big);
  while (i > 0 && classOf(text[i - 1]!, big) === kind) i--;
  return Math.max(i, 0);
}

export function wordEnd(text: string, caret: number, big = false): number {
  let i = caret + 1;
  while (i < text.length && classOf(text[i]!, big) === 0) i++;
  if (i >= text.length) return Math.min(i, Math.max(text.length - 1, 0));

  const kind = classOf(text[i]!, big);
  while (i < text.length - 1 && classOf(text[i + 1]!, big) === kind) i++;
  return i;
}

/**
 * `f`/`F`/`t`/`T`. Stays on the caret's own line — a find that ran off the end
 * of the line would be a jump, and vim does not do that.
 */
export function findChar(
  text: string,
  caret: number,
  char: string,
  forward: boolean,
  till: boolean,
): number | null {
  const start = lineStart(text, caret);
  const end = lineEnd(text, caret);

  if (forward) {
    // `t` repeated from the character before the target would never advance, so
    // the search begins past it.
    let i = caret + (till && text[caret + 1] === char ? 2 : 1);
    for (; i < end; i++) if (text[i] === char) return till ? i - 1 : i;
    return null;
  }

  let i = caret - (till && text[caret - 1] === char ? 2 : 1);
  for (; i >= start; i--) if (text[i] === char) return till ? i + 1 : i;
  return null;
}

const PAIRS: Record<string, { match: string; forward: boolean }> = {
  "(": { match: ")", forward: true },
  ")": { match: "(", forward: false },
  "[": { match: "]", forward: true },
  "]": { match: "[", forward: false },
  "{": { match: "}", forward: true },
  "}": { match: "{", forward: false },
};

/** `%`: the match for the bracket under the caret, or the next one on the line. */
export function matchPair(text: string, caret: number): number | null {
  let at = caret;
  const end = lineEnd(text, caret);
  while (at < end && !PAIRS[text[at]!]) at++;

  const pair = PAIRS[text[at]!];
  if (!pair) return null;

  const open = text[at]!;
  const step = pair.forward ? 1 : -1;
  let depth = 0;

  for (let i = at; i >= 0 && i < text.length; i += step) {
    if (text[i] === open) depth++;
    else if (text[i] === pair.match) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** `{` and `}`: the next blank line in that direction. */
export function paragraph(text: string, caret: number, forward: boolean): number {
  const blank = (at: number) => text.slice(lineStart(text, at), lineEnd(text, at)).trim() === "";

  if (forward) {
    let i = lineEnd(text, caret);
    while (i < text.length) {
      const next = i + 1;
      if (blank(next) && next > caret) return next;
      i = lineEnd(text, next);
      if (next >= text.length) break;
    }
    return text.length;
  }

  let i = lineStart(text, caret);
  while (i > 0) {
    const previous = lineStart(text, i - 1);
    if (blank(previous) && previous < caret) return previous;
    i = previous;
  }
  return 0;
}

const OBJECT_PAIRS: Record<string, [string, string]> = {
  "(": ["(", ")"],
  ")": ["(", ")"],
  b: ["(", ")"],
  "[": ["[", "]"],
  "]": ["[", "]"],
  "{": ["{", "}"],
  "}": ["{", "}"],
  B: ["{", "}"],
  "<": ["<", ">"],
  ">": ["<", ">"],
};

const QUOTES = ['"', "'", "`"];

/**
 * `iw`, `a"`, `i(` and friends. Returns a half-open span, or null when the
 * caret is not inside such an object.
 */
export function textObject(
  text: string,
  caret: number,
  kind: string,
  inner: boolean,
): Span | null {
  if (kind === "w" || kind === "W") return wordObject(text, caret, kind === "W", inner);
  if (kind === "p") return paragraphObject(text, caret, inner);
  if (QUOTES.includes(kind)) return quoteObject(text, caret, kind, inner);
  if (kind === "t") return tagObject(text, caret, inner);

  const pair = OBJECT_PAIRS[kind];
  return pair ? pairObject(text, caret, pair[0], pair[1], inner) : null;
}

function wordObject(text: string, caret: number, big: boolean, inner: boolean): Span | null {
  if (text.length === 0) return null;
  const at = Math.min(caret, text.length - 1);
  const kind = classOf(text[at]!, big);

  let from = at;
  while (from > 0 && classOf(text[from - 1]!, big) === kind) from--;
  let to = at;
  while (to < text.length - 1 && classOf(text[to + 1]!, big) === kind) to++;
  to++;

  if (inner) return { from, to };

  // `aw` takes the trailing whitespace, or the leading whitespace when there is
  // none to take.
  let after = to;
  while (after < text.length && classOf(text[after]!, big) === 0 && text[after] !== "\n") after++;
  if (after > to) return { from, to: after };

  let before = from;
  while (before > 0 && classOf(text[before - 1]!, big) === 0 && text[before - 1] !== "\n") before--;
  return { from: before, to };
}

function paragraphObject(text: string, caret: number, inner: boolean): Span | null {
  const blankAt = (at: number) => text.slice(lineStart(text, at), lineEnd(text, at)).trim() === "";

  let from = lineStart(text, caret);
  while (from > 0 && !blankAt(lineStart(text, from - 1))) from = lineStart(text, from - 1);

  let to = lineEnd(text, caret);
  while (to < text.length && !blankAt(to + 1)) to = lineEnd(text, to + 1);

  if (inner) return { from, to };

  while (to < text.length && blankAt(to + 1)) to = lineEnd(text, to + 1);
  return { from, to: Math.min(to + 1, text.length) };
}

function quoteObject(text: string, caret: number, quote: string, inner: boolean): Span | null {
  const start = lineStart(text, caret);
  const end = lineEnd(text, caret);

  const positions: number[] = [];
  for (let i = start; i < end; i++) {
    if (text[i] === quote && text[i - 1] !== "\\") positions.push(i);
  }

  for (let i = 0; i + 1 < positions.length; i += 2) {
    const open = positions[i]!;
    const close = positions[i + 1]!;
    if (caret <= close) {
      return inner ? { from: open + 1, to: close } : { from: open, to: close + 1 };
    }
  }
  return null;
}

function pairObject(
  text: string,
  caret: number,
  open: string,
  close: string,
  inner: boolean,
): Span | null {
  let depth = 0;
  let from = -1;
  for (let i = caret; i >= 0; i--) {
    if (text[i] === close && i !== caret) depth++;
    else if (text[i] === open) {
      if (depth === 0) {
        from = i;
        break;
      }
      depth--;
    }
  }
  if (from === -1) return null;

  depth = 0;
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      if (depth === 0) {
        return inner ? { from: from + 1, to: i } : { from, to: i + 1 };
      }
      depth--;
    }
  }
  return null;
}

/** `it`/`at` over the innermost enclosing element. */
function tagObject(text: string, caret: number, inner: boolean): Span | null {
  const open = /<([A-Za-z][-\w]*)(\s[^<>]*?)?>/g;
  let best: Span | null = null;

  for (let match = open.exec(text); match; match = open.exec(text)) {
    const name = match[1]!;
    const openFrom = match.index;
    const openTo = openFrom + match[0].length;

    const close = new RegExp(`</${name}\\s*>`, "g");
    close.lastIndex = openTo;
    const closing = close.exec(text);
    if (!closing) continue;

    if (caret < openFrom || caret >= closing.index + closing[0].length) continue;

    const span = inner
      ? { from: openTo, to: closing.index }
      : { from: openFrom, to: closing.index + closing[0].length };

    // Innermost wins, so keep narrowing.
    if (!best || span.to - span.from < best.to - best.from) best = span;
  }
  return best;
}

/**
 * Literal substring search with vim's smartcase: an all-lowercase pattern
 * ignores case, one with a capital in it does not. Wraps around, so `n` at the
 * end of the buffer keeps going.
 */
export function searchFrom(
  text: string,
  from: number,
  pattern: string,
  forward: boolean,
): number | null {
  if (pattern === "") return null;

  const sensitive = pattern !== pattern.toLowerCase();
  const haystack = sensitive ? text : text.toLowerCase();
  const needle = sensitive ? pattern : pattern.toLowerCase();

  if (forward) {
    const at = haystack.indexOf(needle, Math.min(from + 1, text.length));
    if (at !== -1) return at;
    const wrapped = haystack.indexOf(needle);
    return wrapped === -1 ? null : wrapped;
  }

  const at = haystack.lastIndexOf(needle, Math.max(from - 1, 0));
  if (at !== -1 && at < from) return at;
  const wrapped = haystack.lastIndexOf(needle);
  return wrapped === -1 || wrapped === from ? null : wrapped;
}

/** 1-indexed line and column, for a status line. */
export function position(text: string, caret: number): { line: number; column: number } {
  const before = text.slice(0, caret);
  return { line: before.split("\n").length, column: caret - lineStart(text, caret) + 1 };
}
