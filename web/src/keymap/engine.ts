export type Mode = "normal" | "insert" | "command" | "search" | "tag";

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
	| { kind: "toggleSelect" }
	| { kind: "toggleSelectNext" }
	| { kind: "visualSelect" }
	| { kind: "tagPrompt" }
	| { kind: "toggleRead" }
	| { kind: "toggleFlag" }
	| { kind: "archive" }
	| { kind: "delete" }
	| { kind: "compose" }
	| { kind: "reply"; all: boolean }
	| { kind: "forward" }
	| { kind: "sync" }
	| { kind: "enterView" }
	| { kind: "toggleFold" }
	| { kind: "foldAll" }
	| { kind: "unfoldAll" }
	| { kind: "scrollDown"; half?: boolean }
	| { kind: "scrollUp"; half?: boolean }
	| { kind: "nextMessage" }
	| { kind: "prevMessage" }
	| { kind: "loadRemote" }
	| { kind: "togglePlain" }
	| { kind: "togglePreferHtml" }
	| { kind: "refresh" }
	| { kind: "switchAccount" }
	| { kind: "saveQuery" }
	| { kind: "enterCommand" }
	| { kind: "enterSearch" }
	| { kind: "nextAccount" }
	| { kind: "prevAccount" }
	| { kind: "settings" }
	| { kind: "closeRight" }
	| { kind: "toggleFullscreen" }
	| { kind: "togglePinned" }
	| { kind: "focusPinned" }
	| { kind: "linkHints" }
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
	{
		keys: "l",
		action: { kind: "focusRight" },
		description: "focus pane right",
	},
	{
		keys: "C-h",
		action: { kind: "focusLeft" },
		description: "focus pane left",
	},
	{
		keys: "C-l",
		action: { kind: "focusRight" },
		description: "focus pane right",
	},
	{
		keys: "C-b",
		action: { kind: "togglePinned" },
		description: "hide or show the pinned split",
	},
	{
		keys: "C-w",
		action: { kind: "focusPinned" },
		description: "focus the pinned split",
	},

	// Scrolling. Global, because every pane scrolls and the chord means the same
	// thing in each: move this view, leave the cursor alone. What a line is comes
	// from the pane — a row in the list and the sidebar, a nudge through a
	// message in the detail pane.
	{
		keys: "C-e",
		action: { kind: "scrollDown" },
		description: "scroll down a line",
	},
	{
		keys: "C-y",
		action: { kind: "scrollUp" },
		description: "scroll up a line",
	},
	{
		keys: "C-d",
		action: { kind: "scrollDown", half: true },
		description: "scroll down half a screen",
	},
	{
		keys: "C-u",
		action: { kind: "scrollUp", half: true },
		description: "scroll up half a screen",
	},

	// Movement — meaning depends on the focused pane
	{
		keys: "j",
		action: { kind: "next" },
		description: "next",
		panes: ["sidebar", "list"],
	},
	{
		keys: "k",
		action: { kind: "prev" },
		description: "previous",
		panes: ["sidebar", "list"],
	},
	{ keys: "gg", action: { kind: "first" }, description: "first" },
	{ keys: "G", action: { kind: "last" }, description: "last" },

	// Sidebar
	{
		keys: "Enter",
		action: { kind: "select" },
		description: "open view or folder",
		panes: ["sidebar"],
	},
	{
		keys: "o",
		action: { kind: "toggleFold" },
		description: "expand or collapse account",
		panes: ["sidebar"],
	},
	{
		keys: "Tab",
		action: { kind: "toggleFold" },
		description: "expand or collapse",
		panes: ["sidebar"],
	},

	// List
	{
		keys: "Enter",
		action: { kind: "open" },
		description: "read thread",
		panes: ["list"],
	},
	{
		keys: "a",
		action: { kind: "archive" },
		description: "mark archive",
		panes: ["list"],
	},
	{
		keys: "d",
		action: { kind: "delete" },
		description: "mark delete",
		panes: ["list"],
	},
	{
		keys: "u",
		action: { kind: "toggleRead" },
		description: "toggle read",
		panes: ["list"],
	},
	{
		keys: "f",
		action: { kind: "toggleFlag" },
		description: "toggle flag",
		panes: ["list"],
	},
	{
		keys: "x",
		action: { kind: "executeMarks" },
		description: "apply what is staged",
		panes: ["list"],
	},
	{
		keys: "X",
		action: { kind: "clearMarks" },
		description: "clear the selection",
		panes: ["list"],
	},
	{
		keys: " ",
		action: { kind: "toggleSelectNext" },
		description: "select this row and move down",
		panes: ["list"],
	},
	{
		keys: "v",
		action: { kind: "visualSelect" },
		description: "select a range",
		panes: ["list"],
	},
	{
		keys: "V",
		action: { kind: "visualSelect" },
		description: "select a range",
		panes: ["list"],
	},
	{
		keys: "t",
		action: { kind: "tagPrompt" },
		description: "stage any tag",
		panes: ["list"],
	},

	// Detail. Reading is scrolling, so j/k move the page and the conversation is
	// walked with a chord — the same split vim makes between a buffer and a list.
	{
		keys: "u",
		action: { kind: "linkHints" },
		description: "label every link, then press its label to open it",
		panes: ["detail"],
	},
	{
		keys: "j",
		action: { kind: "scrollDown" },
		description: "scroll down",
		panes: ["detail"],
	},
	{
		keys: "k",
		action: { kind: "scrollUp" },
		description: "scroll up",
		panes: ["detail"],
	},
	{
		keys: "J",
		action: { kind: "nextMessage" },
		description: "next message in thread",
		panes: ["detail"],
	},
	{
		keys: "K",
		action: { kind: "prevMessage" },
		description: "previous message in thread",
		panes: ["detail"],
	},
	{
		keys: "Enter",
		action: { kind: "enterView" },
		description: "put a cursor in the message",
		panes: ["detail"],
	},
	{
		keys: "v",
		action: { kind: "enterView" },
		description: "put a cursor in the message",
		panes: ["detail"],
	},
	{
		keys: "za",
		action: { kind: "toggleFold" },
		description: "fold message",
		panes: ["detail"],
	},
	{
		keys: "zM",
		action: { kind: "foldAll" },
		description: "fold all messages",
		panes: ["detail"],
	},
	{
		keys: "zR",
		action: { kind: "unfoldAll" },
		description: "unfold all messages",
		panes: ["detail"],
	},
	{
		keys: "i",
		action: { kind: "loadRemote" },
		description: "load remote images",
		panes: ["detail"],
	},
	{
		keys: "t",
		action: { kind: "togglePlain" },
		description: "html or plain text",
		panes: ["detail"],
	},
	// The same question asked of every message rather than this one: `t` is a
	// choice about what is on screen, `T` changes the preference it starts
	// from. Global, because it is a setting and not a thing about the message.
	{
		keys: "T",
		action: { kind: "togglePreferHtml" },
		description: "prefer html for every message",
	},
	{
		keys: "q",
		action: { kind: "closeRight" },
		description: "close the pane",
		panes: ["detail"],
	},
	// The settings pane is edited like a buffer, so it is left like one. Inside
	// the shared file's editor the sequence is the vim state machine's own; this
	// is the same key on the tabs that are switches rather than text.
	{
		keys: "ZQ",
		action: { kind: "closeRight" },
		description: "close the pane",
		panes: ["detail"],
	},
	{
		keys: "f",
		action: { kind: "toggleFullscreen" },
		description: "toggle fullscreen",
		panes: ["detail"],
	},

	// Global. Walking the conversation is not detail-pane work: following the
	// selection puts the thread on screen while the cursor is still in the list,
	// and that is exactly when the next message is wanted.
	{
		keys: "C-j",
		action: { kind: "nextMessage" },
		description: "next message in thread",
	},
	{
		keys: "C-k",
		action: { kind: "prevMessage" },
		description: "previous message in thread",
	},
	{
		keys: "C-n",
		action: { kind: "nextMessage" },
		description: "next message in thread",
	},
	{
		keys: "C-p",
		action: { kind: "prevMessage" },
		description: "previous message in thread",
	},

	{ keys: "c", action: { kind: "compose" }, description: "compose" },
	// `r` means two things, and which one depends on where the cursor is. In
	// the list it is the reader's reflex for *refresh* — every other client
	// they have used binds it there — and answering a thread they have not
	// opened yet is not what they asked for. Reply belongs where a message is
	// on screen. Both are `r` because a pane-scoped binding is exactly the
	// mechanism for a key that means the local thing.
	{
		keys: "r",
		action: { kind: "refresh" },
		description: "refresh the list",
		panes: ["sidebar", "list"],
	},
	{
		keys: "r",
		action: { kind: "reply", all: false },
		description: "reply",
		panes: ["detail"],
	},
	{ keys: "R", action: { kind: "reply", all: true }, description: "reply all" },
	{ keys: "F", action: { kind: "forward" }, description: "forward" },
	{ keys: "s", action: { kind: "sync" }, description: "sync" },
	{
		keys: "A",
		action: { kind: "switchAccount" },
		description: "switch account",
	},
	{ keys: "]a", action: { kind: "nextAccount" }, description: "next account" },
	{
		keys: "[a",
		action: { kind: "prevAccount" },
		description: "previous account",
	},
	{ keys: ",", action: { kind: "settings" }, description: "settings" },
	{
		keys: "S",
		action: { kind: "saveQuery" },
		description: "save this query to the sidebar",
		panes: ["sidebar", "list"],
	},
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
	/**
	 * `count` is the digits typed before the key, as in vim: `4j`. It is
	 * carried rather than applied here because the engine has no idea what an
	 * action does — repeating a motion four times is what was asked for, and
	 * repeating "stage delete" four times toggles it twice and stages nothing.
	 * Who honours a count is the dispatcher's decision.
	 */
	| { type: "action"; action: Action; count?: number; consumed: true }
	| { type: "pending"; sequence: string; consumed: true }
	| { type: "cancelled"; consumed: true }
	| { type: "ignored"; consumed: false };

/**
 * Sequence timeout in milliseconds. A partial sequence older than this is
 * abandoned so a stray `g` cannot swallow the next keystroke forever.
 */
export const SEQUENCE_TIMEOUT = 1500;

/** How many times one key may be asked to repeat. */
const COUNT_LIMIT = 999;

export class Keymap {
	private bindings: Binding[];
	private pending = "";
	private pendingAt = 0;
	private count = "";

	constructor(bindings: Binding[] = DEFAULT_BINDINGS) {
		this.bindings = bindings;
	}

	/** What is on screen as unfinished input: the count and the partial keys. */
	get sequence(): string {
		return this.count + this.pending;
	}

	reset(): void {
		this.pending = "";
		this.pendingAt = 0;
		this.count = "";
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

		// Ctrl chords are matched whole and work in every mode, including while a
		// text field has focus, so they can move away from an open editor. They are
		// pane-scoped like everything else, and a pane-specific chord wins.
		if (event.ctrl) {
			const name = chordName(event);
			const scoped = this.inPane(pane);
			const chord =
				scoped.find((b) => b.keys === name && b.panes) ??
				scoped.find((b) => b.keys === name);

			return chord
				? { type: "action", action: chord.action, consumed: true }
				: { type: "ignored", consumed: false };
		}

		if (event.key === "Escape") {
			const wasPending = this.sequence !== "";
			this.reset();
			return wasPending || mode !== "normal" || editing
				? { type: "cancelled", consumed: true }
				: { type: "ignored", consumed: false };
		}

		if (editing || mode !== "normal") {
			return { type: "ignored", consumed: false };
		}

		if (this.sequence !== "" && now - this.pendingAt > SEQUENCE_TIMEOUT) {
			this.reset();
		}

		// A digit before a key is a count, as in vim. `0` is the exception, and
		// only while nothing has been counted yet: on its own it is a key like
		// any other and could be bound, but inside `10` it is a digit.
		if (
			this.pending === "" &&
			event.key >= "0" &&
			event.key <= "9" &&
			!(event.key === "0" && this.count === "")
		) {
			if (this.count.length < String(COUNT_LIMIT).length) {
				this.count += event.key;
			}
			this.pendingAt = now;
			return { type: "pending", sequence: this.sequence, consumed: true };
		}

		const scoped = this.inPane(pane);
		const candidate = this.pending + event.key;

		// A pane-specific binding wins over a global one on the same keys.
		const exact =
			scoped.find((b) => b.keys === candidate && b.panes) ??
			scoped.find((b) => b.keys === candidate);
		if (exact) {
			const count = this.count === "" ? undefined : Number(this.count);
			this.reset();
			return count === undefined
				? { type: "action", action: exact.action, consumed: true }
				: { type: "action", action: exact.action, count, consumed: true };
		}

		if (scoped.some((b) => b.keys.startsWith(candidate))) {
			this.pending = candidate;
			this.pendingAt = now;
			return { type: "pending", sequence: this.sequence, consumed: true };
		}

		// `zq` is not a binding, but `q` is. Rather than swallow the key that
		// ended a dead sequence, abandon the prefix and try the key on its own.
		// The count survives it: it was typed before the prefix and belongs to
		// whatever key finally lands.
		if (this.pending) {
			const count = this.count;
			this.reset();
			this.count = count;
			// And the clock with it, or the retry's own staleness check reads a
			// count restored a microsecond ago as one typed and abandoned.
			this.pendingAt = now;
			return this.handle(event, mode, editing, pane, now);
		}

		this.reset();
		return { type: "ignored", consumed: false };
	}

	describe(pane?: Pane): Binding[] {
		return pane ? this.inPane(pane) : [...this.bindings];
	}
}
