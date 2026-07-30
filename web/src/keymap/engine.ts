export type Mode = "normal" | "insert" | "command" | "search";

export type Action =
  | { kind: "next" }
  | { kind: "prev" }
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "open" }
  | { kind: "back" }
  | { kind: "paneLeft" }
  | { kind: "paneRight" }
  | { kind: "mark"; tag: string }
  | { kind: "executeMarks" }
  | { kind: "clearMarks" }
  | { kind: "toggleRead" }
  | { kind: "toggleFlag" }
  | { kind: "archive" }
  | { kind: "delete" }
  | { kind: "compose" }
  | { kind: "reply"; all: boolean }
  | { kind: "forward" }
  | { kind: "sync" }
  | { kind: "toggleFold" }
  | { kind: "foldAll" }
  | { kind: "unfoldAll" }
  | { kind: "enterCommand" }
  | { kind: "enterSearch" }
  | { kind: "nextAccount" }
  | { kind: "prevAccount" }
  | { kind: "help" };

export interface Binding {
  keys: string;
  action: Action;
  description: string;
}

export const DEFAULT_BINDINGS: Binding[] = [
  { keys: "j", action: { kind: "next" }, description: "next" },
  { keys: "k", action: { kind: "prev" }, description: "previous" },
  { keys: "gg", action: { kind: "first" }, description: "first" },
  { keys: "G", action: { kind: "last" }, description: "last" },
  { keys: "Enter", action: { kind: "open" }, description: "open" },
  { keys: "l", action: { kind: "open" }, description: "open" },
  { keys: "h", action: { kind: "back" }, description: "back" },
  { keys: "H", action: { kind: "paneLeft" }, description: "pane left" },
  { keys: "L", action: { kind: "paneRight" }, description: "pane right" },
  { keys: "za", action: { kind: "toggleFold" }, description: "toggle fold" },
  { keys: "zM", action: { kind: "foldAll" }, description: "fold all" },
  { keys: "zR", action: { kind: "unfoldAll" }, description: "unfold all" },
  { keys: "a", action: { kind: "archive" }, description: "archive" },
  { keys: "d", action: { kind: "delete" }, description: "delete" },
  { keys: "u", action: { kind: "toggleRead" }, description: "toggle read" },
  { keys: "f", action: { kind: "toggleFlag" }, description: "flag" },
  { keys: "x", action: { kind: "executeMarks" }, description: "execute marks" },
  { keys: "X", action: { kind: "clearMarks" }, description: "clear marks" },
  { keys: "c", action: { kind: "compose" }, description: "compose" },
  { keys: "r", action: { kind: "reply", all: false }, description: "reply" },
  { keys: "R", action: { kind: "reply", all: true }, description: "reply all" },
  { keys: "F", action: { kind: "forward" }, description: "forward" },
  { keys: "s", action: { kind: "sync" }, description: "sync" },
  { keys: "]a", action: { kind: "nextAccount" }, description: "next account" },
  { keys: "[a", action: { kind: "prevAccount" }, description: "prev account" },
  { keys: ":", action: { kind: "enterCommand" }, description: "command" },
  { keys: "/", action: { kind: "enterSearch" }, description: "search" },
  { keys: "?", action: { kind: "help" }, description: "help" },
];

export interface KeyEvent {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export type Outcome =
  | { type: "action"; action: Action; consumed: true }
  | { type: "pending"; sequence: string; consumed: true }
  | { type: "cancelled"; consumed: true }
  | { type: "ignored"; consumed: false };

/**
 * Sequence timeout in milliseconds. A partial sequence older than this is
 * abandoned so a stray `g` cannot swallow the next keystroke forever.
 */
export const SEQUENCE_TIMEOUT = 1500;

export class Keymap {
  private bindings: Binding[];
  private pending = "";
  private pendingAt = 0;

  constructor(bindings: Binding[] = DEFAULT_BINDINGS) {
    this.bindings = bindings;
  }

  get sequence(): string {
    return this.pending;
  }

  reset(): void {
    this.pending = "";
    this.pendingAt = 0;
  }

  /**
   * `mode` and `editing` together decide whether a key is ours at all.
   * `editing` is true whenever a text input holds focus, which is the rule
   * that keeps typing in a field from triggering navigation.
   */
  handle(event: KeyEvent, mode: Mode, editing: boolean, now = Date.now()): Outcome {
    if (event.ctrl || event.alt || event.meta) {
      return { type: "ignored", consumed: false };
    }

    if (event.key === "Escape") {
      const wasPending = this.pending !== "";
      this.reset();
      return wasPending || mode !== "normal" || editing
        ? { type: "cancelled", consumed: true }
        : { type: "ignored", consumed: false };
    }

    if (editing || mode !== "normal") {
      return { type: "ignored", consumed: false };
    }

    if (this.pending && now - this.pendingAt > SEQUENCE_TIMEOUT) {
      this.reset();
    }

    const candidate = this.pending + normalize(event.key);
    const exact = this.bindings.find((b) => b.keys === candidate);
    if (exact) {
      this.reset();
      return { type: "action", action: exact.action, consumed: true };
    }

    const prefixed = this.bindings.some((b) => b.keys.startsWith(candidate));
    if (prefixed) {
      this.pending = candidate;
      this.pendingAt = now;
      return { type: "pending", sequence: candidate, consumed: true };
    }

    this.reset();
    return { type: "ignored", consumed: false };
  }

  describe(): Binding[] {
    return [...this.bindings];
  }
}

function normalize(key: string): string {
  return key.length === 1 ? key : key;
}
