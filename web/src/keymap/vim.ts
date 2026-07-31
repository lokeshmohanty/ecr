/**
 * Modal editing over a flat string plus a caret. Pure, so the whole grammar is
 * testable without a DOM: the component only has to apply the result to a
 * textarea.
 */
export type VimMode = "normal" | "insert" | "visual";

export interface EditorState {
  text: string;
  caret: number;
  mode: VimMode;
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
  return {
    ...state,
    text: state.text.slice(0, start) + state.text.slice(end),
    caret: start,
    register: state.text.slice(start, end),
  };
}

function insertAt(state: EditorState, at: number, value: string): EditorState {
  return {
    ...state,
    text: state.text.slice(0, at) + value + state.text.slice(at),
    caret: at + value.length,
  };
}

/** Applies one keystroke. Returns the new state; unhandled keys return it unchanged. */
export function handleKey(state: EditorState, event: VimKey): EditorState {
  // Chords belong to the browser and the OS. Without this, Ctrl+D started a
  // delete operator instead of passing through.
  if (event.alt || event.meta || event.ctrl) return state;

  if (state.mode === "insert") return insertMode(state, event);
  return normalMode(state, event);
}

function insertMode(state: EditorState, event: VimKey): EditorState {
  if (event.key === "Escape") {
    return {
      ...state,
      mode: "normal",
      caret: Math.max(state.caret - 1, lineStart(state.text, state.caret)),
      status: "",
    };
  }
  if (event.ctrl) return state;

  if (event.key === "Enter") return insertAt(state, state.caret, "\n");
  if (event.key === "Tab") return insertAt(state, state.caret, "  ");
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
  if (event.key.length === 1) return insertAt(state, state.caret, event.key);

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
  const clear = { pending: "", status: "" };

  if (event.key === "Escape") {
    return { ...state, ...clear, mode: "normal", anchor: null };
  }

  // Operators waiting for a motion.
  if (pending === "d" || pending === "c" || pending === "y") {
    const op = pending;
    const applied = applyOperator(state, op, event.key);
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
      return { ...state, ...clear, caret: down(text, caret) };
    case "k":
      return { ...state, ...clear, caret: up(text, caret) };
    case "0":
      return { ...state, ...clear, caret: lineStart(text, caret) };
    case "^":
      return { ...state, ...clear, caret: firstNonBlank(text, caret) };
    case "$":
      return { ...state, ...clear, caret: lineEnd(text, caret) };
    case "w":
      return { ...state, ...clear, caret: wordForward(text, caret) };
    case "b":
      return { ...state, ...clear, caret: wordBack(text, caret) };
    case "e":
      return { ...state, ...clear, caret: wordEnd(text, caret) };
    case "G":
      return { ...state, ...clear, caret: text.length };

    // Entering insert
    case "i":
      return { ...state, ...clear, mode: "insert" };
    case "a":
      return { ...state, ...clear, mode: "insert", caret: Math.min(caret + 1, text.length) };
    case "I":
      return { ...state, ...clear, mode: "insert", caret: firstNonBlank(text, caret) };
    case "A":
      return { ...state, ...clear, mode: "insert", caret: lineEnd(text, caret) };
    case "o": {
      const at = lineEnd(text, caret);
      return { ...insertAt(state, at, "\n"), ...clear, mode: "insert" };
    }
    case "O": {
      const at = lineStart(text, caret);
      const next = insertAt(state, at, "\n");
      return { ...next, ...clear, mode: "insert", caret: at };
    }

    // Edits
    case "x":
      return { ...deleteRange(state, caret, Math.min(caret + 1, text.length)), ...clear };
    case "D":
      return { ...deleteRange(state, caret, lineEnd(text, caret)), ...clear };
    case "C":
      return { ...deleteRange(state, caret, lineEnd(text, caret)), ...clear, mode: "insert" };
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
      return { ...state, pending: event.key, status: event.key };

    default:
      return { ...motionOnly(state, event), ...clear };
  }
}

function applyOperator(state: EditorState, op: string, key: string): EditorState | null {
  const { text, caret } = state;
  const clear = { pending: "", status: "" };

  // Doubled operator acts on the whole line.
  if ((op === "d" && key === "d") || (op === "c" && key === "c") || (op === "y" && key === "y")) {
    const start = lineStart(text, caret);
    const end = lineEnd(text, caret);

    if (op === "y") {
      return { ...state, ...clear, register: text.slice(start, end) };
    }
    if (op === "c") {
      return { ...deleteRange(state, start, end), ...clear, mode: "insert" };
    }
    const withNewline = end < text.length ? end + 1 : end;
    return { ...deleteRange(state, start, withNewline), ...clear };
  }

  const target = motionTarget(text, caret, key);
  if (target === null) return null;

  if (op === "y") {
    const from = Math.min(caret, target);
    const to = Math.max(caret, target);
    return { ...state, ...clear, register: text.slice(from, to) };
  }

  const deleted = deleteRange(state, caret, target);
  return { ...deleted, ...clear, mode: op === "c" ? "insert" : "normal" };
}

function motionTarget(text: string, caret: number, key: string): number | null {
  switch (key) {
    case "w":
      return wordForward(text, caret);
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
