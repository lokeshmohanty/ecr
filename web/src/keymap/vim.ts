/**
 * Modal editing over a flat string plus a caret. Pure, so the whole grammar is
 * testable without a DOM: the component only has to apply the result to a
 * textarea.
 */
export type VimMode = "normal" | "insert" | "visual";

export interface Snapshot {
  text: string;
  caret: number;
}

export interface EditorState {
  text: string;
  caret: number;
  mode: VimMode;
  /** Undo stack. An insert session collapses into one entry on Escape. */
  history: Snapshot[];
  /** Buffer state when insert mode was entered, so the session undoes as one. */
  insertAnchor: Snapshot | null;
  /** Digits typed before a command, e.g. the 3 in 3dd. */
  count: string;
  /** Anchor of the visual selection, or null outside visual mode. */
  anchor: number | null;
  pending: string;
  register: string;
  /** Set when the buffer should be handed back (`:w`, `:wq`, `ZZ`). */
  submit: boolean;
  /** Set when editing should be abandoned (`:q!`, `ZQ`). */
  cancel: boolean;
  status: string;
}

export function initialState(text: string, mode: VimMode = "insert"): EditorState {
  return {
    text,
    caret: text.length,
    mode,
    history: [],
    insertAnchor: null,
    count: "",
    anchor: null,
    pending: "",
    register: "",
    submit: false,
    cancel: false,
    status: "",
  };
}

export interface VimKey {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
  /** Text from a paste event, inserted verbatim. */
  paste?: string;
}

const HISTORY_LIMIT = 200;

/** Records the buffer before an edit so `u` can step back to it. */
function remember(state: EditorState): Snapshot[] {
  const history = [...state.history, { text: state.text, caret: state.caret }];
  return history.length > HISTORY_LIMIT ? history.slice(-HISTORY_LIMIT) : history;
}

function undo(state: EditorState): EditorState {
  const previous = state.history.at(-1);
  if (!previous) return { ...state, pending: "", count: "", status: "already at the oldest change" };

  return {
    ...state,
    text: previous.text,
    caret: previous.caret,
    history: state.history.slice(0, -1),
    pending: "",
    count: "",
    status: "",
  };
}

const WORD = /[A-Za-z0-9_]/;

export function lineStart(text: string, caret: number): number {
  const before = text.lastIndexOf("\n", Math.max(caret - 1, 0));
  return caret === 0 ? 0 : before + 1;
}

export function lineEnd(text: string, caret: number): number {
  const next = text.indexOf("\n", caret);
  return next === -1 ? text.length : next;
}

function firstNonBlank(text: string, caret: number): number {
  const start = lineStart(text, caret);
  const end = lineEnd(text, caret);
  let i = start;
  while (i < end && /\s/.test(text[i]!)) i++;
  return i;
}

function up(text: string, caret: number): number {
  const start = lineStart(text, caret);
  if (start === 0) return caret;
  const column = caret - start;
  const prevStart = lineStart(text, start - 1);
  return Math.min(prevStart + column, start - 1);
}

function down(text: string, caret: number): number {
  const end = lineEnd(text, caret);
  if (end === text.length) return caret;
  const column = caret - lineStart(text, caret);
  const nextStart = end + 1;
  return Math.min(nextStart + column, lineEnd(text, nextStart));
}

function wordForward(text: string, caret: number): number {
  let i = caret;
  const inWord = i < text.length && WORD.test(text[i]!);
  if (inWord) while (i < text.length && WORD.test(text[i]!)) i++;
  else while (i < text.length && !WORD.test(text[i]!) && !/\s/.test(text[i]!)) i++;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

function wordBack(text: string, caret: number): number {
  let i = caret - 1;
  while (i > 0 && /\s/.test(text[i]!)) i--;
  while (i > 0 && WORD.test(text[i - 1]!)) i--;
  return Math.max(i, 0);
}

function wordEnd(text: string, caret: number): number {
  let i = caret + 1;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  while (i < text.length - 1 && WORD.test(text[i + 1]!)) i++;
  return Math.min(i, text.length);
}

function deleteRange(state: EditorState, from: number, to: number): EditorState {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  if (start === end) return state;

  return {
    ...state,
    history: remember(state),
    text: state.text.slice(0, start) + state.text.slice(end),
    caret: start,
    register: state.text.slice(start, end),
  };
}

function insertAt(state: EditorState, at: number, value: string, record = true): EditorState {
  return {
    ...state,
    history: record ? remember(state) : state.history,
    text: state.text.slice(0, at) + value + state.text.slice(at),
    caret: at + value.length,
  };
}

/** Applies one keystroke. Returns the new state; unhandled keys return it unchanged. */
export function handleKey(state: EditorState, event: VimKey): EditorState {
  // Chords belong to the browser and the OS. Without this, Ctrl+D started a
  // delete operator instead of passing through.
  if (event.alt || event.meta || event.ctrl) return state;

  if (event.paste !== undefined) {
    const anchor = state.mode === "insert" ? state.insertAnchor : null;
    const next = insertAt(state, state.caret, event.paste, state.mode !== "insert");
    return { ...next, mode: "insert", insertAnchor: anchor ?? { text: state.text, caret: state.caret } };
  }

  if (state.mode === "insert") return insertMode(state, event);
  return normalMode(state, event);
}

function insertMode(state: EditorState, event: VimKey): EditorState {
  if (event.key === "Escape") {
    // The whole insert session becomes one undo entry.
    const anchor = state.insertAnchor;
    const history =
      anchor && anchor.text !== state.text ? [...state.history, anchor] : state.history;

    return {
      ...state,
      mode: "normal",
      history: history.length > HISTORY_LIMIT ? history.slice(-HISTORY_LIMIT) : history,
      insertAnchor: null,
      caret: Math.max(state.caret - 1, lineStart(state.text, state.caret)),
      status: "",
    };
  }

  if (event.key === "Enter") return insertAt(state, state.caret, "\n", false);
  if (event.key === "Tab") return insertAt(state, state.caret, "  ", false);
  if (event.key === "Backspace") {
    if (state.caret === 0) return state;
    return {
      ...state,
      text: state.text.slice(0, state.caret - 1) + state.text.slice(state.caret),
      caret: state.caret - 1,
    };
  }
  if (event.key === "Delete") {
    return {
      ...state,
      text: state.text.slice(0, state.caret) + state.text.slice(state.caret + 1),
    };
  }
  if (event.key.length === 1) return insertAt(state, state.caret, event.key, false);

  return motionOnly(state, event);
}

/** Arrow keys and Home/End work in every mode. */
function motionOnly(state: EditorState, event: VimKey): EditorState {
  switch (event.key) {
    case "ArrowLeft":
      return { ...state, caret: Math.max(state.caret - 1, 0) };
    case "ArrowRight":
      return { ...state, caret: Math.min(state.caret + 1, state.text.length) };
    case "ArrowUp":
      return { ...state, caret: up(state.text, state.caret) };
    case "ArrowDown":
      return { ...state, caret: down(state.text, state.caret) };
    case "Home":
      return { ...state, caret: lineStart(state.text, state.caret) };
    case "End":
      return { ...state, caret: lineEnd(state.text, state.caret) };
    default:
      return state;
  }
}

function normalMode(state: EditorState, event: VimKey): EditorState {
  const { text, caret } = state;
  const pending = state.pending;
  const clear = { pending: "", status: "", count: "" };
  const anchor = { text: state.text, caret: state.caret };

  if (event.key === "Escape") {
    return { ...state, ...clear, mode: "normal", anchor: null };
  }

  // A leading digit is a count, not a command. `0` only counts once one has
  // started, so a bare `0` stays the go-to-column-zero motion.
  if (/^[0-9]$/.test(event.key) && !(event.key === "0" && state.count === "")) {
    return { ...state, count: state.count + event.key, status: state.count + event.key };
  }

  const times = Math.min(Math.max(parseInt(state.count || "1", 10), 1), 1000);

  if (event.key === "u" && pending === "") {
    return undo(state);
  }

  /** Applies a single-step motion `times` over. */
  const repeat = (step: (at: number) => number): number => {
    let at = caret;
    for (let i = 0; i < times; i++) at = step(at);
    return at;
  };

  // Operators waiting for a motion.
  if (pending === "d" || pending === "c" || pending === "y") {
    const op = pending;
    const applied = applyOperator(state, op, event.key, times, anchor);
    if (applied) return applied;
    return { ...state, ...clear };
  }

  if (pending === "g") {
    if (event.key === "g") return { ...state, ...clear, caret: 0 };
    return { ...state, ...clear };
  }

  if (pending === "Z") {
    if (event.key === "Z") return { ...state, ...clear, submit: true };
    if (event.key === "Q") return { ...state, ...clear, cancel: true };
    return { ...state, ...clear };
  }

  switch (event.key) {
    // Motions
    case "h":
      return { ...state, ...clear, caret: Math.max(caret - 1, lineStart(text, caret)) };
    case "l":
      return { ...state, ...clear, caret: Math.min(caret + 1, lineEnd(text, caret)) };
    case "j":
      return { ...state, ...clear, caret: repeat((at) => down(text, at)) };
    case "k":
      return { ...state, ...clear, caret: repeat((at) => up(text, at)) };
    case "0":
      return { ...state, ...clear, caret: lineStart(text, caret) };
    case "^":
      return { ...state, ...clear, caret: firstNonBlank(text, caret) };
    case "$":
      return { ...state, ...clear, caret: lineEnd(text, caret) };
    case "w":
      return { ...state, ...clear, caret: repeat((at) => wordForward(text, at)) };
    case "b":
      return { ...state, ...clear, caret: repeat((at) => wordBack(text, at)) };
    case "e":
      return { ...state, ...clear, caret: wordEnd(text, caret) };
    case "G":
      return { ...state, ...clear, caret: text.length };

    // Entering insert
    case "i":
      return { ...state, ...clear, mode: "insert", insertAnchor: anchor };
    case "a":
      return {
        ...state, ...clear, mode: "insert", insertAnchor: anchor,
        caret: Math.min(caret + 1, text.length),
      };
    case "I":
      return {
        ...state, ...clear, mode: "insert", insertAnchor: anchor,
        caret: firstNonBlank(text, caret),
      };
    case "A":
      return {
        ...state, ...clear, mode: "insert", insertAnchor: anchor,
        caret: lineEnd(text, caret),
      };
    case "o": {
      const at = lineEnd(text, caret);
      return { ...insertAt(state, at, "\n"), ...clear, mode: "insert", insertAnchor: anchor };
    }
    case "O": {
      const at = lineStart(text, caret);
      const next = insertAt(state, at, "\n");
      return { ...next, ...clear, mode: "insert", caret: at, insertAnchor: anchor };
    }

    // Edits
    case "x":
      return {
        ...deleteRange(state, caret, Math.min(caret + times, lineEnd(text, caret))),
        ...clear,
      };
    case "D":
      return { ...deleteRange(state, caret, lineEnd(text, caret)), ...clear };
    case "C":
      return {
        ...deleteRange(state, caret, lineEnd(text, caret)),
        ...clear, mode: "insert", insertAnchor: anchor,
      };
    case "p": {
      if (!state.register) return { ...state, ...clear };
      return { ...insertAt(state, caret + 1, state.register), ...clear };
    }
    case "P": {
      if (!state.register) return { ...state, ...clear };
      return { ...insertAt(state, caret, state.register), ...clear };
    }

    // Operator and multi-key prefixes
    case "d":
    case "c":
    case "y":
    case "g":
    case "Z":
      // The count survives into the operator, so 2dd deletes two lines.
      return { ...state, pending: event.key, status: state.count + event.key };

    default:
      return { ...motionOnly(state, event), ...clear };
  }
}

function applyOperator(
  state: EditorState,
  op: string,
  key: string,
  times: number,
  anchor: Snapshot,
): EditorState | null {
  const { text, caret } = state;
  const clear = { pending: "", status: "", count: "" };

  // Doubled operator acts on whole lines.
  if ((op === "d" && key === "d") || (op === "c" && key === "c") || (op === "y" && key === "y")) {
    const start = lineStart(text, caret);

    let end = lineEnd(text, caret);
    for (let i = 1; i < times && end < text.length; i++) {
      end = lineEnd(text, end + 1);
    }

    if (op === "y") {
      return { ...state, ...clear, register: text.slice(start, end) };
    }
    if (op === "c") {
      return { ...deleteRange(state, start, end), ...clear, mode: "insert", insertAnchor: anchor };
    }
    const withNewline = end < text.length ? end + 1 : end;
    return { ...deleteRange(state, start, withNewline), ...clear };
  }

  let target: number | null = caret;
  for (let i = 0; i < times; i++) {
    const next = motionTarget(text, target, key);
    if (next === null) return null;
    target = next;
  }
  if (target === null) return null;

  if (op === "y") {
    const from = Math.min(caret, target);
    const to = Math.max(caret, target);
    return { ...state, ...clear, register: text.slice(from, to) };
  }

  const deleted = deleteRange(state, caret, target);
  return {
    ...deleted,
    ...clear,
    mode: op === "c" ? "insert" : "normal",
    insertAnchor: op === "c" ? anchor : null,
  };
}

function motionTarget(text: string, caret: number, key: string): number | null {
  switch (key) {
    case "w": {
      const next = wordForward(text, caret);
      const end = lineEnd(text, caret);
      return Math.min(next, end);
    }
    case "b":
      return wordBack(text, caret);
    case "e":
      return wordEnd(text, caret) + 1;
    case "$":
      return lineEnd(text, caret);
    case "0":
      return lineStart(text, caret);
    case "^":
      return firstNonBlank(text, caret);
    case "l":
      return Math.min(caret + 1, text.length);
    case "h":
      return Math.max(caret - 1, 0);
    default:
      return null;
  }
}

/** 1-indexed line and column, for a status line. */
export function position(text: string, caret: number): { line: number; column: number } {
  const before = text.slice(0, caret);
  const line = before.split("\n").length;
  return { line, column: caret - lineStart(text, caret) + 1 };
}
