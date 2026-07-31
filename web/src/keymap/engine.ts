export type Mode = "normal" | "insert" | "command" | "search";

/** Which pane owns the keyboard. `h`/`l` move between them. */
export type Pane = "sidebar" | "list" | "detail";

export type Action =
  | { kind: "next" }
  | { kind: "prev" }
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "open" }
  | { kind: "focusLeft" }
  | { kind: "focusRight" }
  | { kind: "select" }
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
  | { kind: "scrollDown" }
  | { kind: "scrollUp" }
  | { kind: "nextMessage" }
  | { kind: "prevMessage" }
  | { kind: "loadRemote" }
  | { kind: "togglePlain" }
  | { kind: "enterCommand" }
  | { kind: "enterSearch" }
  | { kind: "nextAccount" }
  | { kind: "prevAccount" }
  | { kind: "settings" }
  | { kind: "closeRight" }
  | { kind: "togglePinned" }
  | { kind: "focusPinned" }
  | { kind: "help" };

export interface Binding {
  keys: string;
  action: Action;
  description: string;
  /** Panes this applies in. Absent means everywhere. */
  panes?: Pane[];
}

export const DEFAULT_BINDINGS: Binding[] = [
  // Focus. The ctrl chords work from anywhere, including mid-edit, which is
  // what makes reading while composing possible.
  { keys: "h", action: { kind: "focusLeft" }, description: "focus pane left" },
  { keys: "l", action: { kind: "focusRight" }, description: "focus pane right" },
  { keys: "C-h", action: { kind: "focusLeft" }, description: "focus pane left" },
  { keys: "C-l", action: { kind: "focusRight" }, description: "focus pane right" },
  { keys: "C-j", action: { kind: "focusPinned" }, description: "focus the pinned split" },
  { keys: "C-k", action: { kind: "focusRight" }, description: "focus the reading pane" },
  { keys: "C-p", action: { kind: "togglePinned" }, description: "hide or show the pinned split" },

  // Movement — meaning depends on the focused pane
  { keys: "j", action: { kind: "next" }, description: "next" },
  { keys: "k", action: { kind: "prev" }, description: "previous" },
  { keys: "gg", action: { kind: "first" }, description: "first" },
  { keys: "G", action: { kind: "last" }, description: "last" },

  // Sidebar
  { keys: "Enter", action: { kind: "select" }, description: "open view or folder", panes: ["sidebar"] },
  { keys: "o", action: { kind: "toggleFold" }, description: "expand or collapse account", panes: ["sidebar"] },

  // List
  { keys: "Enter", action: { kind: "open" }, description: "read thread", panes: ["list"] },
  { keys: "a", action: { kind: "archive" }, description: "mark archive", panes: ["list"] },
  { keys: "d", action: { kind: "delete" }, description: "mark delete", panes: ["list"] },
  { keys: "u", action: { kind: "toggleRead" }, description: "toggle read", panes: ["list"] },
  { keys: "f", action: { kind: "toggleFlag" }, description: "toggle flag", panes: ["list"] },
  { keys: "x", action: { kind: "executeMarks" }, description: "execute marks", panes: ["list"] },
  { keys: "X", action: { kind: "clearMarks" }, description: "clear marks", panes: ["list"] },

  // Detail
  { keys: "J", action: { kind: "nextMessage" }, description: "next message in thread", panes: ["detail"] },
  { keys: "K", action: { kind: "prevMessage" }, description: "previous message in thread", panes: ["detail"] },
  { keys: "za", action: { kind: "toggleFold" }, description: "fold message", panes: ["detail"] },
  { keys: "zM", action: { kind: "foldAll" }, description: "fold all messages", panes: ["detail"] },
  { keys: "zR", action: { kind: "unfoldAll" }, description: "unfold all messages", panes: ["detail"] },
  { keys: "i", action: { kind: "loadRemote" }, description: "load remote images", panes: ["detail"] },
  { keys: "t", action: { kind: "togglePlain" }, description: "html or plain text", panes: ["detail"] },
  { keys: "q", action: { kind: "closeRight" }, description: "close the pane", panes: ["detail"] },

  // Global
  { keys: "c", action: { kind: "compose" }, description: "compose" },
  { keys: "r", action: { kind: "reply", all: false }, description: "reply" },
  { keys: "R", action: { kind: "reply", all: true }, description: "reply all" },
  { keys: "F", action: { kind: "forward" }, description: "forward" },
  { keys: "s", action: { kind: "sync" }, description: "sync" },
  { keys: "]a", action: { kind: "nextAccount" }, description: "next account" },
  { keys: "[a", action: { kind: "prevAccount" }, description: "previous account" },
  { keys: ",", action: { kind: "settings" }, description: "settings" },
  { keys: ":", action: { kind: "enterCommand" }, description: "command" },
  { keys: "/", action: { kind: "enterSearch" }, description: "search" },
  { keys: "?", action: { kind: "help" }, description: "help" },
];

/** Chords are written `C-h` in a binding table. */
export function chordName(event: KeyEvent): string {
  return event.ctrl ? `C-${event.key}` : event.key;
}

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

  replace(bindings: Binding[]): void {
    this.bindings = bindings;
    this.reset();
  }

  /** Bindings live in a pane when they name it, or everywhere when they do not. */
  private inPane(pane: Pane): Binding[] {
    return this.bindings.filter((b) => !b.panes || b.panes.includes(pane));
  }

  /**
   * `mode` and `editing` together decide whether a key is ours at all.
   * `editing` is true whenever a text input holds focus, which is the rule
   * that keeps typing in a field from triggering navigation.
   */
  handle(
    event: KeyEvent,
    mode: Mode,
    editing: boolean,
    pane: Pane = "list",
    now = Date.now(),
  ): Outcome {
    if (event.alt || event.meta) {
      return { type: "ignored", consumed: false };
    }

    // Ctrl chords are matched directly and work in every mode, including while
    // a text field has focus, so they can move away from an open editor.
    if (event.ctrl) {
      const chord = this.bindings.find((b) => b.keys === chordName(event));
      return chord
        ? { type: "action", action: chord.action, consumed: true }
        : { type: "ignored", consumed: false };
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

    const scoped = this.inPane(pane);
    const candidate = this.pending + event.key;

    // A pane-specific binding wins over a global one on the same keys.
    const exact =
      scoped.find((b) => b.keys === candidate && b.panes) ??
      scoped.find((b) => b.keys === candidate);
    if (exact) {
      this.reset();
      return { type: "action", action: exact.action, consumed: true };
    }

    if (scoped.some((b) => b.keys.startsWith(candidate))) {
      this.pending = candidate;
      this.pendingAt = now;
      return { type: "pending", sequence: candidate, consumed: true };
    }

    // `zq` is not a binding, but `q` is. Rather than swallow the key that
    // ended a dead sequence, abandon the prefix and try the key on its own.
    if (this.pending) {
      this.reset();
      return this.handle(event, mode, editing, pane, now);
    }

    this.reset();
    return { type: "ignored", consumed: false };
  }

  describe(pane?: Pane): Binding[] {
    return pane ? this.inPane(pane) : [...this.bindings];
  }
}
