/**
 * Modal editing over a flat string plus a caret. Pure, so the whole grammar is
 * testable without a DOM: the component only has to apply the result to a
 * textarea and drain the side channels (`clipboard`, `command`, `submit`).
 */
import {
  findChar,
  firstNonBlank,
  lineEnd,
  lineStart,
  matchPair,
  paragraph,
  searchFrom,
  textObject,
  wordBack,
  wordEnd,
  wordForward,
  down,
  up,
  type Span,
} from "./motions";

export { lineStart, lineEnd, position } from "./motions";

export type VimMode = "normal" | "insert" | "visual";

export interface Snapshot {
  text: string;
  caret: number;
}

export interface Register {
  text: string;
  /** Yanked whole lines paste onto a new line rather than mid-word. */
  linewise: boolean;
}

export interface EditorState {
  text: string;
  caret: number;
  mode: VimMode;
  /** Undo stack. An insert session collapses into one entry on Escape. */
  history: Snapshot[];
  redo: Snapshot[];
  /** Buffer state when insert mode was entered, so the session undoes as one. */
  insertAnchor: Snapshot | null;
  /** Digits typed before a command, e.g. the 3 in 3dd. */
  count: string;
  /** Anchor of the visual selection, or null outside visual mode. */
  anchor: number | null;
  visualLine: boolean;
  /** The last visual selection, for `gv`. */
  lastVisual: { anchor: number; caret: number; line: boolean } | null;
  pending: string;
  /** The unnamed register. */
  register: string;
  registerLinewise: boolean;
  registers: Record<string, Register>;
  /** Register named with `"a` for the command about to run. */
  pendingRegister: string | null;
  lastFind: { char: string; forward: boolean; till: boolean } | null;
  search: { pattern: string; forward: boolean } | null;
  /** `/`, `?` or `:` while a prompt is open. */
  promptKind: "/" | "?" | ":" | null;
  prompt: string;
  /** Keystrokes of the change in progress, and the text it started from. */
  replay: VimKey[] | null;
  replayFrom: string | null;
  lastChange: VimKey[] | null;
  replaying: boolean;
  /** Header fields have no second line: Enter and Tab leave instead. */
  singleLine: boolean;
  /** Yanked text for the host to put on the system clipboard. Drain after use. */
  clipboard: string | null;
  /** An ex command the editor does not own, e.g. `:attach`. Drain after use. */
  command: string | null;
  /** Set when the buffer should be handed back (`:w`, `:wq`, `ZZ`, `C-c C-c`). */
  submit: boolean;
  /** Set when editing should be abandoned (`:q!`, `ZQ`, `C-c C-k`). */
  cancel: boolean;
  /** Tab and Shift-Tab: move to the next or previous field. */
  next: boolean;
  previous: boolean;
  status: string;
}

export function initialState(
	text: string,
	mode: VimMode = "insert",
	singleLine = false,
): EditorState {
	return {
		text,
		// Normal mode rests *on* a character, as in vim. Past the last one there is
		// nothing for the block cursor to cover, so it would look like no cursor.
		caret: mode === "normal" ? Math.max(text.length - 1, 0) : text.length,
		mode,
		history: [],
		redo: [],
		insertAnchor: null,
		count: "",
		anchor: null,
		visualLine: false,
		lastVisual: null,
		pending: "",
		register: "",
		registerLinewise: false,
		registers: {},
		pendingRegister: null,
		lastFind: null,
		search: null,
		promptKind: null,
		prompt: "",
		replay: null,
		replayFrom: null,
		lastChange: null,
		replaying: false,
		singleLine,
		clipboard: null,
		command: null,
		submit: false,
		cancel: false,
		next: false,
		previous: false,
		status: "",
	};
}

/**
 * Switch to a mode without a keystroke, for the focus handoff between header
 * fields. Entering insert records an anchor so the session undoes as one;
 * entering normal steps the caret back onto a character, as `Escape` does.
 */
export function switchMode(state: EditorState, mode: VimMode): EditorState {
	if (state.mode === mode) return state;
	if (mode === "insert") {
		return {
			...state,
			mode: "insert",
			anchor: null,
			visualLine: false,
			insertAnchor: { text: state.text, caret: state.caret },
		};
	}
	return {
		...state,
		mode,
		anchor: null,
		visualLine: false,
		insertAnchor: null,
		caret: Math.max(state.caret - 1, lineStart(state.text, state.caret)),
	};
}

export interface VimKey {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
  shift?: boolean;
  /** Text from a paste event, inserted verbatim. */
  paste?: string;
}

const HISTORY_LIMIT = 200;

/** Ctrl chords the editor claims. Everything else belongs to the app. */
export function handlesCtrl(state: EditorState, key: string): boolean {
  if (state.pending === "C-c") return true;
  if (key === "c") return true;
  return state.mode !== "insert" && (key === "r" || key === "a" || key === "x");
}

/** Records the buffer before an edit so `u` can step back to it. */
function remember(state: EditorState): Snapshot[] {
  const history = [...state.history, { text: state.text, caret: state.caret }];
  return history.length > HISTORY_LIMIT ? history.slice(-HISTORY_LIMIT) : history;
}

function undo(state: EditorState): EditorState {
  const previous = state.history.at(-1);
  if (!previous) return { ...state, ...CLEAR, status: "already at the oldest change" };

  return {
    ...state,
    ...CLEAR,
    text: previous.text,
    caret: previous.caret,
    history: state.history.slice(0, -1),
    redo: [...state.redo, { text: state.text, caret: state.caret }],
  };
}

function redo(state: EditorState): EditorState {
  const next = state.redo.at(-1);
  if (!next) return { ...state, ...CLEAR, status: "already at the newest change" };

  return {
    ...state,
    ...CLEAR,
    text: next.text,
    caret: next.caret,
    history: remember(state),
    redo: state.redo.slice(0, -1),
  };
}

const CLEAR = { pending: "", status: "", count: "", pendingRegister: null } as const;

function clamp(text: string, caret: number): number {
  return Math.min(Math.max(caret, 0), Math.max(text.length, 0));
}

function deleteRange(state: EditorState, from: number, to: number): EditorState {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  if (start === end) return state;

  return {
    ...state,
    history: remember(state),
    redo: [],
    text: state.text.slice(0, start) + state.text.slice(end),
    caret: start,
    ...store(state, state.text.slice(start, end), false),
  };
}

function insertAt(state: EditorState, at: number, value: string, record = true): EditorState {
  return {
    ...state,
    history: record ? remember(state) : state.history,
    redo: record ? [] : state.redo,
    text: state.text.slice(0, at) + value + state.text.slice(at),
    caret: at + value.length,
  };
}

/** Where a yank or delete goes: the named register when one was given. */
function store(state: EditorState, text: string, linewise: boolean) {
  const name = state.pendingRegister;
  return {
    register: text,
    registerLinewise: linewise,
    registers: name ? { ...state.registers, [name]: { text, linewise } } : state.registers,
    clipboard: text,
  };
}

function recall(state: EditorState): Register {
  const name = state.pendingRegister;
  if (name && state.registers[name]) return state.registers[name]!;
  return { text: state.register, linewise: state.registerLinewise };
}

/** Applies one keystroke. Returns the new state; unhandled keys return it unchanged. */
export function handleKey(state: EditorState, event: VimKey): EditorState {
  return record(state, event, apply(state, event));
}

function apply(state: EditorState, event: VimKey): EditorState {
  if (event.paste !== undefined) return pasted(state, event.paste);
  if (state.promptKind) return promptMode(state, event);
  if (event.alt || event.meta) return state;
  if (event.ctrl && !handlesCtrl(state, event.key)) return state;

  // The C-c chord outranks the mode: it has to finish from inside an insert
  // session, which is the whole point of having it.
  if (state.pending === "C-c") return chordC(state, event);

  if (state.mode === "insert") return insertMode(state, event);
  return normalMode(state, event);
}

/** `C-c C-c` applies, `C-c C-k` discards, anything else is an Escape. */
function chordC(state: EditorState, event: VimKey): EditorState {
  const key = event.ctrl ? `C-${event.key}` : event.key;
  if (key === "C-c") return { ...state, ...CLEAR, submit: true };
  if (key === "C-k") return { ...state, ...CLEAR, cancel: true };

  const cleared = { ...state, ...CLEAR };
  return cleared.mode === "insert" ? insertMode(cleared, { key: "Escape" }) : cleared;
}

function pasted(state: EditorState, text: string): EditorState {
  const value = state.singleLine ? text.replace(/[\r\n]+/g, " ") : text;
  const anchor = state.mode === "insert" ? state.insertAnchor : null;
  const next = insertAt(state, state.caret, value, state.mode !== "insert");

  return {
    ...next,
    mode: "insert",
    anchor: null,
    insertAnchor: anchor ?? { text: state.text, caret: state.caret },
  };
}

/**
 * The change just made, remembered as the keys that made it, so `.` can run
 * them again. Recording starts at the first key of a change and ends when the
 * editor settles back into normal mode.
 */
function record(before: EditorState, event: VimKey, after: EditorState): EditorState {
  if (after.replaying || before.replaying) return after;
  if (before.mode === "visual" || event.key === ".") return after;

  const begins =
    (before.pending === "" && after.pending !== "") ||
    (before.count === "" && after.count !== "") ||
    (before.mode !== "insert" && after.mode === "insert") ||
    after.text !== before.text;

  if (before.replay === null && !begins) return after;

  const keys = [...(before.replay ?? []), event];
  const from = before.replay === null ? before.text : (before.replayFrom ?? before.text);

  // An outstanding count is not settled: `2x` has to record the 2 as well, or
  // `.` would repeat it once.
  const settled =
    after.pending === "" &&
    after.count === "" &&
    after.mode === "normal" &&
    after.promptKind === null;
  if (!settled) return { ...after, replay: keys, replayFrom: from };

  return {
    ...after,
    replay: null,
    replayFrom: null,
    lastChange: after.text === from ? after.lastChange : keys,
  };
}

function repeatChange(state: EditorState): EditorState {
  const keys = state.lastChange;
  if (!keys || keys.length === 0) return { ...state, ...CLEAR, status: "nothing to repeat" };

  let next: EditorState = { ...state, ...CLEAR, replaying: true };
  for (const key of keys) next = apply(next, key);
  return { ...next, replaying: false, replay: null, replayFrom: null, lastChange: keys };
}

function insertMode(state: EditorState, event: VimKey): EditorState {
  const key = event.ctrl ? `C-${event.key}` : event.key;

  if (key === "C-c") return { ...state, pending: "C-c", status: "C-c" };

  if (key === "Escape") {
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

  if (key === "Enter") {
    if (state.singleLine) return { ...state, next: true };
    return insertAt(state, state.caret, "\n", false);
  }
  if (key === "Tab") {
    if (state.singleLine) return { ...state, [event.shift ? "previous" : "next"]: true };
    return insertAt(state, state.caret, "  ", false);
  }
  if (key === "Backspace") {
    if (state.caret === 0) return state;
    return {
      ...state,
      text: state.text.slice(0, state.caret - 1) + state.text.slice(state.caret),
      caret: state.caret - 1,
    };
  }
  if (key === "Delete") {
    return {
      ...state,
      text: state.text.slice(0, state.caret) + state.text.slice(state.caret + 1),
    };
  }
  if (key.length === 1 && !event.ctrl) return insertAt(state, state.caret, key, false);

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

/** The half-open span a visual selection covers. */
export function selectionSpan(state: EditorState): Span {
  const anchor = state.anchor ?? state.caret;
  const from = Math.min(anchor, state.caret);
  const to = Math.max(anchor, state.caret);

  if (state.visualLine) {
    const end = lineEnd(state.text, to);
    return { from: lineStart(state.text, from), to: Math.min(end + 1, state.text.length) };
  }
  return { from, to: Math.min(to + 1, state.text.length) };
}

function promptMode(state: EditorState, event: VimKey): EditorState {
  if (event.key === "Escape" || (event.ctrl && event.key === "c")) {
    return { ...state, promptKind: null, prompt: "", status: "" };
  }
  if (event.key === "Backspace") {
    if (state.prompt === "") return { ...state, promptKind: null, status: "" };
    const prompt = state.prompt.slice(0, -1);
    return { ...state, prompt, status: `${state.promptKind}${prompt}` };
  }
  if (event.key === "Enter") {
    const kind = state.promptKind!;
    const value = state.prompt;
    const closed = { ...state, promptKind: null, prompt: "", status: "" } as EditorState;
    return kind === ":" ? runCommand(closed, value) : runSearch(closed, value, kind === "/");
  }
  if (event.paste !== undefined) {
    const prompt = state.prompt + event.paste;
    return { ...state, prompt, status: `${state.promptKind}${prompt}` };
  }
  if (event.key.length === 1 && !event.ctrl) {
    const prompt = state.prompt + event.key;
    return { ...state, prompt, status: `${state.promptKind}${prompt}` };
  }
  return state;
}

function runSearch(state: EditorState, pattern: string, forward: boolean): EditorState {
  if (pattern === "") return state;

  const at = searchFrom(state.text, state.caret, pattern, forward);
  const search = { pattern, forward };
  if (at === null) return { ...state, search, status: `not found: ${pattern}` };
  return { ...state, search, caret: at, status: "" };
}

function repeatSearch(state: EditorState, same: boolean): EditorState {
  if (!state.search) return { ...state, ...CLEAR, status: "no previous search" };

  const forward = same ? state.search.forward : !state.search.forward;
  const at = searchFrom(state.text, state.caret, state.search.pattern, forward);
  if (at === null) return { ...state, ...CLEAR, status: `not found: ${state.search.pattern}` };
  return { ...state, ...CLEAR, caret: at };
}

function runCommand(state: EditorState, input: string): EditorState {
  const command = input.trim();

  switch (command) {
    case "w":
    case "wq":
    case "x":
      return { ...state, submit: true };
    case "q":
    case "q!":
      return { ...state, cancel: true };
    case "":
      return state;
    default:
      // Anything the editor does not own is the host's to interpret.
      return { ...state, command };
  }
}

function normalMode(state: EditorState, event: VimKey): EditorState {
  const key = event.ctrl ? `C-${event.key}` : event.key;
  const { text, caret } = state;
  const pending = state.pending;
  const visual = state.mode === "visual";
  const anchor = { text: state.text, caret: state.caret };

  if (key === "Escape") {
    return { ...state, ...CLEAR, mode: "normal", anchor: null, promptKind: null, prompt: "" };
  }

  // Multi-key prefixes, resolved before anything else claims the key.
  if (pending !== "") {
    const resolved = resolvePending(state, key, event);
    if (resolved) return resolved;
  }

  // A leading digit is a count, not a command. `0` only counts once one has
  // started, so a bare `0` stays the go-to-column-zero motion.
  if (/^[0-9]$/.test(key) && !(key === "0" && state.count === "")) {
    return { ...state, count: state.count + key, status: state.count + key };
  }

  const times = Math.min(Math.max(parseInt(state.count || "1", 10), 1), 1000);

  /** Applies a single-step motion `times` over. */
  const repeat = (step: (at: number) => number): number => {
    let at = caret;
    for (let i = 0; i < times; i++) at = step(at);
    return at;
  };

  const move = (to: number): EditorState => ({ ...state, ...CLEAR, caret: clamp(text, to) });

  switch (key) {
    // Motions
    case "h":
      return move(Math.max(caret - times, lineStart(text, caret)));
    case "l": {
      // Normal mode rests *on* a character, so the last column is one short of
      // the line end. Never move left: a caret already past that limit stays.
      const limit = Math.max(lineEnd(text, caret) - (visual ? 0 : 1), lineStart(text, caret));
      return move(Math.max(caret, Math.min(caret + times, limit)));
    }
    case "j":
      // A single-line field has no second line to move to, so j/k walk the
      // header rows instead — the same surface Tab does, for a hand on the
      // home row that never left it.
      if (state.singleLine && !visual) return { ...state, ...CLEAR, next: true };
      return move(repeat((at) => down(text, at)));
    case "k":
      if (state.singleLine && !visual) return { ...state, ...CLEAR, previous: true };
      return move(repeat((at) => up(text, at)));
    case "0":
      return move(lineStart(text, caret));
    case "^":
      return move(firstNonBlank(text, caret));
    case "$":
      return move(lineEnd(text, caret));
    case "w":
      return move(repeat((at) => wordForward(text, at)));
    case "W":
      return move(repeat((at) => wordForward(text, at, true)));
    case "b":
      return move(repeat((at) => wordBack(text, at)));
    case "B":
      return move(repeat((at) => wordBack(text, at, true)));
    case "e":
      return move(repeat((at) => wordEnd(text, at)));
    case "E":
      return move(repeat((at) => wordEnd(text, at, true)));
    case "G":
      return move(state.count ? lineOf(text, times) : text.length);
    case "{":
      return move(repeat((at) => paragraph(text, at, false)));
    case "}":
      return move(repeat((at) => paragraph(text, at, true)));
    case "%": {
      const at = matchPair(text, caret);
      return at === null ? { ...state, ...CLEAR } : move(at);
    }
    case ";":
    case ",": {
      const find = state.lastFind;
      if (!find) return { ...state, ...CLEAR };
      const forward = key === ";" ? find.forward : !find.forward;
      const at = findChar(text, caret, find.char, forward, find.till);
      return at === null ? { ...state, ...CLEAR } : move(at);
    }
    case "n":
      return repeatSearch(state, true);
    case "N":
      return repeatSearch(state, false);

    // Prompts
    case "/":
    case "?":
      return { ...state, ...CLEAR, promptKind: key, prompt: "", status: key };
    case ":":
      return { ...state, ...CLEAR, promptKind: ":", prompt: "", status: ":" };

    // Visual mode
    case "v":
      if (visual && !state.visualLine) return leaveVisual(state);
      return { ...state, ...CLEAR, mode: "visual", visualLine: false, anchor: state.anchor ?? caret };
    case "V":
      if (visual && state.visualLine) return leaveVisual(state);
      return { ...state, ...CLEAR, mode: "visual", visualLine: true, anchor: state.anchor ?? caret };
    case "o":
      if (visual) {
        return { ...state, ...CLEAR, caret: state.anchor ?? caret, anchor: caret };
      }
      return openLine(state, lineEnd(text, caret), false, anchor);

    // Tab walks between surfaces from normal mode everywhere, so the body of a
    // message cycles to the headers just as the headers cycle to each other.
    case "Tab":
      return { ...state, ...CLEAR, [event.shift ? "previous" : "next"]: true };

    // Repeat, undo, redo
    case ".":
      return repeatChange(state);
    case "u":
      return undo(state);
    case "C-r":
      return redo(state);

    case "C-a":
    case "C-x":
      return increment(state, key === "C-a" ? times : -times);
  }

  if (visual) return visualCommand(state, key, event, times);
  return normalCommand(state, key, event, times, anchor);
}

function leaveVisual(state: EditorState): EditorState {
  return {
    ...state,
    ...CLEAR,
    mode: "normal",
    anchor: null,
    lastVisual: {
      anchor: state.anchor ?? state.caret,
      caret: state.caret,
      line: state.visualLine,
    },
  };
}

/** `G` with a count goes to that line. */
function lineOf(text: string, line: number): number {
  let at = 0;
  for (let i = 1; i < line; i++) {
    const end = lineEnd(text, at);
    if (end >= text.length) return at;
    at = end + 1;
  }
  return at;
}

function normalCommand(
  state: EditorState,
  key: string,
  event: VimKey,
  times: number,
  anchor: Snapshot,
): EditorState {
  const { text, caret } = state;

  switch (key) {
    // Entering insert
    case "i":
      return { ...state, ...CLEAR, mode: "insert", insertAnchor: anchor };
    case "a":
      return {
        ...state, ...CLEAR, mode: "insert", insertAnchor: anchor,
        caret: Math.min(caret + 1, text.length),
      };
    case "I":
      return {
        ...state, ...CLEAR, mode: "insert", insertAnchor: anchor,
        caret: firstNonBlank(text, caret),
      };
    case "A":
      return {
        ...state, ...CLEAR, mode: "insert", insertAnchor: anchor,
        caret: lineEnd(text, caret),
      };
    case "O":
      return openLine(state, lineStart(text, caret), true, anchor);

    // Edits
    case "x":
      return {
        ...deleteRange(state, caret, Math.min(caret + times, lineEnd(text, caret))),
        ...CLEAR,
      };
    case "X":
      return {
        ...deleteRange(state, Math.max(caret - times, lineStart(text, caret)), caret),
        ...CLEAR,
      };
    case "D":
      return { ...deleteRange(state, caret, lineEnd(text, caret)), ...CLEAR };
    case "C":
      return {
        ...deleteRange(state, caret, lineEnd(text, caret)),
        ...CLEAR, mode: "insert", insertAnchor: anchor,
      };
    case "s":
      return {
        ...deleteRange(state, caret, Math.min(caret + times, lineEnd(text, caret))),
        ...CLEAR, mode: "insert", insertAnchor: anchor,
      };
    case "S": {
      const start = lineStart(text, caret);
      return {
        ...deleteRange(state, start, lineEnd(text, caret)),
        ...CLEAR, mode: "insert", insertAnchor: anchor,
      };
    }
    case "Y":
      return yankSpan(state, { from: lineStart(text, caret), to: lineEnd(text, caret) }, true);
    case "J":
      return join(state, times);
    case "~":
      return toggleCase(state, { from: caret, to: Math.min(caret + times, text.length) }, false);
    case "p":
    case "P":
      return put(state, key === "p");
    case "gv":
      return restoreVisual(state);

    // Prefixes
    case "d":
    case "c":
    case "y":
    case "g":
    case "Z":
    case "z":
    case ">":
    case "<":
    case "f":
    case "F":
    case "t":
    case "T":
    case "r":
    case '"':
    case "C-c":
      // The count survives into the operator, so 2dd deletes two lines.
      return { ...state, pending: key, status: state.count + key };

    default:
      return { ...motionOnly(state, event), ...CLEAR };
  }
}

function visualCommand(
  state: EditorState,
  key: string,
  event: VimKey,
  times: number,
): EditorState {
  const span = selectionSpan(state);

  switch (key) {
    case "d":
    case "x":
      return { ...leaveVisual(removeSpan(state, span)), ...CLEAR };
    case "c":
    case "s": {
      const anchor = { text: state.text, caret: state.caret };
      const removed = removeSpan(state, span);
      return {
        ...leaveVisual(removed), ...CLEAR,
        mode: "insert", insertAnchor: anchor,
      };
    }
    case "y":
      return {
        ...leaveVisual(yankSpan(state, span, state.visualLine)),
        ...CLEAR,
        caret: span.from,
      };
    case "p": {
      const value = recall(state);
      const removed = removeSpan(state, span);
      return {
        ...leaveVisual(insertAt(removed, span.from, value.text, false)),
        ...CLEAR,
      };
    }
    case "~":
    case "u":
    case "U":
      return { ...leaveVisual(toggleCase(state, span, key !== "~", key === "U")), ...CLEAR };
    case ">":
    case "<":
      return { ...leaveVisual(indent(state, span, key === ">", times)), ...CLEAR };
    case "J":
      return { ...leaveVisual(joinSpan(state, span)), ...CLEAR };
    case "i":
    case "a":
      return { ...state, pending: key, status: key };
    case "r":
    case '"':
      return { ...state, pending: key, status: key };
    case "g":
    case "Z":
    case "C-c":
      return { ...state, pending: key, status: key };
    default:
      return { ...motionOnly(state, event), ...CLEAR };
  }
}

function restoreVisual(state: EditorState): EditorState {
  const last = state.lastVisual;
  if (!last) return { ...state, ...CLEAR };
  return {
    ...state, ...CLEAR,
    mode: "visual",
    anchor: clamp(state.text, last.anchor),
    caret: clamp(state.text, last.caret),
    visualLine: last.line,
  };
}

function openLine(
  state: EditorState,
  at: number,
  above: boolean,
  anchor: Snapshot,
): EditorState {
  if (state.singleLine) return { ...state, ...CLEAR, mode: "insert", insertAnchor: anchor };

  const next = insertAt(state, at, "\n");
  return {
    ...next, ...CLEAR,
    mode: "insert",
    caret: above ? at : next.caret,
    insertAnchor: anchor,
  };
}

function yankSpan(state: EditorState, span: Span, linewise: boolean): EditorState {
  const value = state.text.slice(span.from, span.to);
  return { ...state, ...store(state, value, linewise) };
}

function removeSpan(state: EditorState, span: Span): EditorState {
  const linewise = state.mode === "visual" && state.visualLine;
  const removed = deleteRange(state, span.from, span.to);
  return { ...removed, ...store(state, state.text.slice(span.from, span.to), linewise) };
}

function put(state: EditorState, after: boolean): EditorState {
  const value = recall(state);
  if (!value.text) return { ...state, ...CLEAR };

  if (value.linewise) {
    const at = after
      ? Math.min(lineEnd(state.text, state.caret) + 1, state.text.length)
      : lineStart(state.text, state.caret);
    const body = value.text.endsWith("\n") ? value.text : `${value.text}\n`;
    const next = insertAt(state, at, body);
    return { ...next, ...CLEAR, caret: at };
  }

  const at = after ? Math.min(state.caret + 1, state.text.length) : state.caret;
  const next = insertAt(state, at, value.text);
  return { ...next, ...CLEAR, caret: Math.max(next.caret - 1, 0) };
}

function join(state: EditorState, times: number): EditorState {
  let next = state;
  for (let i = 0; i < Math.max(times, 1); i++) {
    const end = lineEnd(next.text, next.caret);
    if (end >= next.text.length) break;

    let after = end + 1;
    while (after < next.text.length && /[ \t]/.test(next.text[after]!)) after++;

    next = {
      ...next,
      history: remember(next),
      redo: [],
      text: `${next.text.slice(0, end)} ${next.text.slice(after)}`,
      caret: end,
    };
  }
  return { ...next, ...CLEAR };
}

/** Joining N selected lines is N-1 joins. */
function joinSpan(state: EditorState, span: Span): EditorState {
  const lines = state.text.slice(span.from, span.to).replace(/\n$/, "").split("\n").length;
  return join({ ...state, caret: span.from }, Math.max(lines - 1, 1));
}

function toggleCase(state: EditorState, span: Span, force: boolean, upper = false): EditorState {
  const value = state.text.slice(span.from, span.to);
  const swapped = force
    ? upper
      ? value.toUpperCase()
      : value.toLowerCase()
    : [...value]
        .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
        .join("");

  return {
    ...state, ...CLEAR,
    history: remember(state),
    redo: [],
    text: state.text.slice(0, span.from) + swapped + state.text.slice(span.to),
    caret: state.mode === "visual" ? span.from : Math.min(span.to, Math.max(state.text.length - 1, 0)),
  };
}

const INDENT = "  ";

function indent(state: EditorState, span: Span, deeper: boolean, times: number): EditorState {
  const from = lineStart(state.text, span.from);
  const to = lineEnd(state.text, Math.max(span.to - 1, span.from));
  const body = state.text.slice(from, to);
  const pad = INDENT.repeat(Math.max(times, 1));

  const shifted = body
    .split("\n")
    .map((line) => {
      if (deeper) return line.trim() === "" ? line : pad + line;
      let trimmed = line;
      for (let i = 0; i < pad.length && trimmed.startsWith(" "); i++) trimmed = trimmed.slice(1);
      return trimmed;
    })
    .join("\n");

  return {
    ...state, ...CLEAR,
    history: remember(state),
    redo: [],
    text: state.text.slice(0, from) + shifted + state.text.slice(to),
    caret: from,
  };
}

/** `C-a` and `C-x` over the number at or after the caret. */
function increment(state: EditorState, by: number): EditorState {
  const { text, caret } = state;
  const end = lineEnd(text, caret);

  let start = caret;
  while (start > lineStart(text, caret) && /[0-9]/.test(text[start - 1]!)) start--;

  let at = start;
  while (at < end && !/[0-9]/.test(text[at]!)) at++;
  if (at >= end) return { ...state, ...CLEAR };

  let from = at;
  while (from > lineStart(text, caret) && /[0-9]/.test(text[from - 1]!)) from--;
  let to = at;
  while (to < end && /[0-9]/.test(text[to]!)) to++;

  const negative = from > 0 && text[from - 1] === "-";
  const value = parseInt(text.slice(negative ? from - 1 : from, to), 10) + by;
  const replaced = String(value);

  return {
    ...state, ...CLEAR,
    history: remember(state),
    redo: [],
    text: text.slice(0, negative ? from - 1 : from) + replaced + text.slice(to),
    caret: (negative ? from - 1 : from) + replaced.length - 1,
  };
}

/**
 * A key arriving while a prefix is outstanding: an operator waiting for a
 * motion or a text object, a find waiting for its character, `Z`, `g`, `z`,
 * `"` or the `C-c` chord.
 */
function resolvePending(state: EditorState, key: string, event: VimKey): EditorState | null {
  const { text, caret } = state;
  const pending = state.pending;
  const times = Math.min(Math.max(parseInt(state.count || "1", 10), 1), 1000);
  const anchor = { text: state.text, caret: state.caret };

  if (pending === "C-c") {
    if (key === "C-c") return { ...state, ...CLEAR, submit: true };
    if (key === "C-k") return { ...state, ...CLEAR, cancel: true };
    return { ...state, ...CLEAR, mode: state.mode === "insert" ? "normal" : state.mode };
  }

  if (pending === "Z") {
    if (key === "Z") return { ...state, ...CLEAR, submit: true };
    if (key === "Q") return { ...state, ...CLEAR, cancel: true };
    return { ...state, ...CLEAR };
  }

  if (pending === '"') {
    return { ...state, pending: "", pendingRegister: key, status: `"${key}` };
  }

  if (pending === "g") {
    if (key === "g") return { ...state, ...CLEAR, caret: state.count ? lineOf(text, times) : 0 };
    if (key === "v") return restoreVisual(state);
    if (key === "u" || key === "U") {
      return { ...state, pending: `g${key}`, status: `g${key}` };
    }
    return { ...state, ...CLEAR };
  }

  if (pending === "z") {
    // Folding belongs to the reader, not the buffer; swallow it here.
    return { ...state, ...CLEAR };
  }

  if (pending === "r") {
    if (key.length !== 1 || event.ctrl) return { ...state, ...CLEAR };

    const span =
      state.mode === "visual"
        ? selectionSpan(state)
        : { from: caret, to: Math.min(caret + times, lineEnd(text, caret)) };
    const width = span.to - span.from;
    if (width <= 0) return { ...state, ...CLEAR };

    const replaced = text
      .slice(span.from, span.to)
      .split("")
      .map((c) => (c === "\n" ? c : key))
      .join("");

    const next = {
      ...state, ...CLEAR,
      history: remember(state),
      redo: [],
      text: text.slice(0, span.from) + replaced + text.slice(span.to),
      caret: span.from,
    };
    return state.mode === "visual" ? leaveVisual(next) : next;
  }

  if (pending === "f" || pending === "F" || pending === "t" || pending === "T") {
    if (key.length !== 1 || event.ctrl) return { ...state, ...CLEAR };

    const forward = pending === "f" || pending === "t";
    const till = pending === "t" || pending === "T";
    let at: number | null = caret;
    for (let i = 0; i < times && at !== null; i++) {
      at = findChar(text, at, key, forward, till);
    }
    const lastFind = { char: key, forward, till };
    return at === null
      ? { ...state, ...CLEAR, lastFind }
      : { ...state, ...CLEAR, lastFind, caret: at };
  }

  // Visual mode: `i`/`a` select a text object rather than starting an insert.
  if (state.mode === "visual" && (pending === "i" || pending === "a")) {
    const span = textObject(text, caret, key, pending === "i");
    if (!span) return { ...state, ...CLEAR };
    return { ...state, ...CLEAR, anchor: span.from, caret: Math.max(span.to - 1, span.from) };
  }

  const operator = pending[0]!;
  if (!"dcy><".includes(operator) && pending !== "gu" && pending !== "gU") {
    return { ...state, ...CLEAR };
  }

  // A text object: the operator is waiting for `iw`, `a(` and friends.
  if (pending.length === 1 && (key === "i" || key === "a")) {
    return { ...state, pending: pending + key, status: state.count + pending + key };
  }
  if (pending.length === 2 && (pending[1] === "i" || pending[1] === "a")) {
    const span = textObject(text, caret, key, pending[1] === "i");
    if (!span) return { ...state, ...CLEAR };
    // A paragraph is a run of lines, so operating on one takes the lines whole.
    return applyOperator(state, pending[0]!, span, key === "p", anchor);
  }

  // The operator is waiting for a find: `dfx`, `ct)`.
  if (pending.length === 1 && "fFtT".includes(key)) {
    return { ...state, pending: pending + key, status: state.count + pending + key };
  }
  if (pending.length === 2 && "fFtT".includes(pending[1]!)) {
    if (key.length !== 1 || event.ctrl) return { ...state, ...CLEAR };

    const kind = pending[1]!;
    const forward = kind === "f" || kind === "t";
    const till = kind === "t" || kind === "T";

    let at: number | null = caret;
    for (let i = 0; i < times && at !== null; i++) {
      at = findChar(text, at, key, forward, till);
    }
    if (at === null) return { ...state, ...CLEAR, lastFind: { char: key, forward, till } };

    // A forward find is inclusive of its target; a backward one is not.
    const span = forward ? { from: caret, to: at + 1 } : { from: at, to: caret };
    return {
      ...applyOperator(state, pending[0]!, span, false, anchor),
      lastFind: { char: key, forward, till },
    };
  }
  if (pending === "gu" || pending === "gU") {
    if (key === "g" || key === "u" || key === "U") {
      const span = { from: lineStart(text, caret), to: lineEnd(text, caret) };
      return toggleCase(state, span, true, pending === "gU");
    }
    const target = motionTarget(state, key, times);
    if (target === null) return { ...state, ...CLEAR };
    return toggleCase(
      state,
      { from: Math.min(caret, target), to: Math.max(caret, target) },
      true,
      pending === "gU",
    );
  }

  // A doubled operator acts on whole lines.
  if (key === operator || (operator === ">" && key === ">") || (operator === "<" && key === "<")) {
    const start = lineStart(text, caret);
    let end = lineEnd(text, caret);
    for (let i = 1; i < times && end < text.length; i++) end = lineEnd(text, end + 1);

    return applyOperator(state, operator, { from: start, to: end }, true, anchor);
  }

  const target = motionTarget(state, key, times);
  if (target === null) return { ...state, ...CLEAR };

  return applyOperator(
    state,
    operator,
    { from: Math.min(caret, target), to: Math.max(caret, target) },
    false,
    anchor,
  );
}

function applyOperator(
  state: EditorState,
  operator: string,
  span: Span,
  linewise: boolean,
  anchor: Snapshot,
): EditorState {
  if (operator === "y") {
    return { ...yankSpan(state, span, linewise), ...CLEAR, caret: span.from };
  }
  if (operator === ">" || operator === "<") {
    return indent(state, span, operator === ">", 1);
  }

  // A linewise delete takes the line ending with it; a change leaves it, so the
  // cursor lands on an empty line to type into.
  const to =
    linewise && operator === "d" && span.to < state.text.length ? span.to + 1 : span.to;

  const stored = { ...state, ...store(state, state.text.slice(span.from, span.to), linewise) };
  const deleted = deleteRange(stored, span.from, to);

  return {
    ...deleted,
    ...CLEAR,
    register: stored.register,
    registerLinewise: stored.registerLinewise,
    registers: stored.registers,
    clipboard: stored.clipboard,
    mode: operator === "c" ? "insert" : "normal",
    insertAnchor: operator === "c" ? anchor : null,
  };
}

function motionTarget(state: EditorState, key: string, times: number): number | null {
  const { text, caret } = state;

  const step = (fn: (at: number) => number): number => {
    let at = caret;
    for (let i = 0; i < times; i++) at = fn(at);
    return at;
  };

  switch (key) {
    case "w":
      return Math.min(step((at) => wordForward(text, at)), lineEnd(text, caret));
    case "W":
      return Math.min(step((at) => wordForward(text, at, true)), lineEnd(text, caret));
    case "b":
      return step((at) => wordBack(text, at));
    case "B":
      return step((at) => wordBack(text, at, true));
    case "e":
      return step((at) => wordEnd(text, at)) + 1;
    case "E":
      return step((at) => wordEnd(text, at, true)) + 1;
    case "$":
      return lineEnd(text, caret);
    case "0":
      return lineStart(text, caret);
    case "^":
      return firstNonBlank(text, caret);
    case "l":
      return Math.min(caret + times, text.length);
    case "h":
      return Math.max(caret - times, 0);
    case "{":
      return step((at) => paragraph(text, at, false));
    case "}":
      return step((at) => paragraph(text, at, true));
    case "%": {
      const at = matchPair(text, caret);
      return at === null ? null : at + (at > caret ? 1 : 0);
    }
    case "G":
      return text.length;
    default:
      return null;
  }
}
