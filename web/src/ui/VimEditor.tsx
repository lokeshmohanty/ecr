import {
	For,
	Show,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
} from "solid-js";
import {
	handleKey,
	handlesCtrl,
	initialState,
	position,
	selectionSpan,
	switchMode,
	type EditorState,
} from "../keymap/vim";
import { softKeys } from "../keymap/soft-keys";
import {
	completeRecipient,
	rankAddresses,
	recipientFragment,
	type AddressEntry,
} from "../state/suggest";
import { overlayRuns } from "./overlay";

export interface VimEditorProps {
	initial: string;
	/** Shown in the status line, e.g. "reply · alice@example.com". */
	label: string;
	onSubmit: (text: string) => void;
	onCancel: () => void;
	onModeChange?: (mode: EditorState["mode"]) => void;
	/** Every keystroke, so a host can keep a draft in step. */
	onChange?: (text: string) => void;
	/** Tab and Shift-Tab out of this surface, carrying the mode that left it. */
	onNextField?: (mode: EditorState["mode"]) => void;
	onPreviousField?: (mode: EditorState["mode"]) => void;
	/** An ex command the editor does not own, e.g. `attach`. */
	onCommand?: (command: string) => void;
	onPasteFiles?: (files: File[]) => void;
	submitLabel?: string;
	/** Enables To/Cc/Bcc completion. */
	addressBook?: AddressEntry[];
	startMode?: EditorState["mode"];
	/** Mode to enter when this surface gains focus via Tab/Enter. */
	focusMode?: EditorState["mode"];
	/** Header fields: one line, no status bar, Enter leaves. */
	singleLine?: boolean;
	/** Which surface holds the keyboard when several are on screen at once. */
	focused?: boolean;
}

/**
 * A textarea driven entirely by the pure vim engine. The textarea keeps native
 * rendering, scrolling and IME, but every keystroke goes through `handleKey` so
 * the modal grammar is the same one the tests exercise.
 *
 * Normal and visual mode paint through a mirror layer rather than the
 * textarea's own selection: a textarea shows one selection and has no caret
 * shape, so a block cursor *and* a visual range cannot both be drawn with it.
 * Insert mode hands rendering back to the textarea, where the native caret is
 * the line cursor and composition works as it should.
 */
export function VimEditor(props: VimEditorProps) {
	let area: HTMLTextAreaElement | undefined;
	let mirror: HTMLDivElement | undefined;

	const [state, setState] = createSignal<EditorState>(
		initialState(
			props.initial,
			props.startMode ?? "normal",
			props.singleLine ?? false,
		),
	);
	const [highlight, setHighlight] = createSignal(0);

	// A block cursor in a field that does not hold the keyboard would read as
	// several cursors at once, so an unfocused surface renders as plain text.
	const painted = () => state().mode !== "insert" && props.focused !== false;

	/** The recipient being typed, if the caret is in a To/Cc/Bcc field. */
	const recipient = createMemo(() => {
		if (!props.addressBook?.length) return null;
		const current = state();
		if (current.mode !== "insert") return null;

		const fragment = recipientFragment(current.text, current.caret);
		if (!fragment || fragment.fragment.length < 2) return null;

		return fragment;
	});

	const matches = createMemo(() => {
		const target = recipient();
		return target
			? rankAddresses(props.addressBook ?? [], target.fragment)
			: [];
	});

	const accept = (email: string) => {
		const target = recipient();
		if (!target) return;

		setState((current) => {
			const replaced = completeRecipient(
				current.text,
				target.start,
				current.caret,
				email,
			);
			return { ...current, text: replaced.text, caret: replaced.caret };
		});
		setHighlight(0);
	};

	// The editor takes the keyboard the moment it opens. Without this the
	// textarea is unfocused, every keystroke falls through to the app, and the
	// editor looks inert.
	onMount(() => {
		if (props.focused !== false) area?.focus({ preventScroll: true });
	});

	// Several surfaces are mounted at once in the composer; only one may hold
	// the keyboard, and Tab moving between them is what decides which.
	createEffect(() => {
		if (props.focused) area?.focus({ preventScroll: true });
	});

	// Tab or Enter out of a field carries the mode the user was in, so an insert
	// session does not collapse to normal on arrival. The source field's mode is
	// passed through the callback and applied here when focus lands.
	createEffect(() => {
		const mode = props.focusMode;
		if (props.focused && mode) setState((s) => switchMode(s, mode));
	});

	const runs = createMemo(() => {
		const current = state();
		if (!painted()) return [];
		const span = current.mode === "visual" ? selectionSpan(current) : null;
		return overlayRuns(current.text, current.caret, span);
	});

	// Keep the DOM caret in step with the model after every change. The selection
	// stays collapsed: the block is the mirror's job now.
	createEffect(() => {
		const current = state();
		if (!area) return;
		if (area.value !== current.text) area.value = current.text;
		area.setSelectionRange(current.caret, current.caret);
		if (mirror) mirror.scrollTop = area.scrollTop;

		props.onModeChange?.(current.mode);
	});

	// Side channels the engine cannot act on itself.
	createEffect(() => {
		const current = state();

		if (current.submit) props.onSubmit(current.text);
		else if (current.cancel) props.onCancel();

		if (current.clipboard !== null) {
			const text = current.clipboard;
			void navigator.clipboard?.writeText(text).catch(() => {});
			setState((s) => ({ ...s, clipboard: null }));
		}
		if (current.command !== null) {
			const command = current.command;
			props.onCommand?.(command);
			setState((s) => ({ ...s, command: null }));
		}
		if (current.next) {
			props.onNextField?.(current.mode);
			setState((s) => ({ ...s, next: false }));
		}
		if (current.previous) {
			props.onPreviousField?.(current.mode);
			setState((s) => ({ ...s, previous: false }));
		}
	});

	createEffect(() => props.onChange?.(state().text));

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.metaKey || event.altKey) return;

		// A soft keyboard does not report which key was pressed: Android's IME
		// fires keydown with `Unidentified` and delivers the text itself in
		// `beforeinput`. Letting this one through without `preventDefault` is what
		// makes that event fire at all — handled below. Everything a hardware
		// keyboard sends is named, and never reaches here.
		if (event.isComposing || event.key === "Unidentified") return;

		// Ctrl chords are the app's unless the editor claims them, which is what
		// lets C-c C-c finish a message from inside an insert session while C-b
		// still hides the pane.
		if (event.ctrlKey) {
			if (!handlesCtrl(state(), event.key)) return;
			event.preventDefault();
			event.stopPropagation();
			setState((current) => handleKey(current, { key: event.key, ctrl: true }));
			return;
		}

		// Recipient completion claims the keys that drive it, but only while a
		// suggestion list is actually on screen.
		const list = matches();
		if (list.length > 0) {
			if (event.key === "Tab" || event.key === "Enter") {
				event.preventDefault();
				event.stopPropagation();
				accept(list[highlight()]!.email);
				return;
			}
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setHighlight((h) => Math.min(h + 1, list.length - 1));
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setHighlight((h) => Math.max(h - 1, 0));
				return;
			}
		}

		// Everything else belongs to the editor, including Escape and Tab, so the
		// browser never steals a key mid-edit.
		event.preventDefault();
		event.stopPropagation();

		setState((current) =>
			handleKey(current, {
				key: event.key,
				ctrl: event.ctrlKey,
				alt: event.altKey,
				meta: event.metaKey,
				shift: event.shiftKey,
			}),
		);
	};

	// A hardware key never arrives here: `onKeyDown` calls `preventDefault`, and
	// that is precisely what stops this event from firing. What is left is the
	// soft keyboard, whose keys `softKeys` names.
	const onBeforeInput = (event: InputEvent) => {
		event.preventDefault();
		event.stopPropagation();

		for (const key of softKeys(event.inputType, event.data)) {
			setState((current) => handleKey(current, { key }));
		}
	};

	const onPaste = (event: ClipboardEvent) => {
		const data = event.clipboardData;
		if (!data) return;

		const files = [...data.items]
			.filter((item) => item.kind === "file")
			.map((item) => item.getAsFile())
			.filter((file): file is File => file !== null);

		if (files.length > 0 && props.onPasteFiles) {
			event.preventDefault();
			event.stopPropagation();
			props.onPasteFiles(files);
			return;
		}

		const text = data.getData("text");
		if (!text) return;

		event.preventDefault();
		event.stopPropagation();
		setState((current) => handleKey(current, { key: "Insert", paste: text }));
	};

	const syncCaretFromClick = () => {
		if (!area) return;
		const caret = area.selectionStart;
		setState((current) => ({ ...current, caret }));
	};

	onCleanup(() => props.onModeChange?.("normal"));

	const where = () => position(state().text, state().caret);

	// Both layers must wrap identically, so every metric that affects line
	// breaking is set in one place and applied to each.
	const typography = `vim-face leading-relaxed whitespace-pre-wrap break-words ${
		props.singleLine ? "px-2 py-0.5" : "p-3"
	}`;

	return (
		<div
			class="flex flex-col"
			classList={{
				"min-h-0 flex-1": !props.singleLine,
				"shrink-0": props.singleLine,
			}}
		>
			<div
				class="relative"
				classList={{
					"min-h-0 flex-1 border-t border-rule": !props.singleLine,
					"h-7": props.singleLine,
				}}
			>
				{/*
          Painted only outside insert mode, so nothing can drift out of step
          with the textarea while text is being typed into it.
        */}
				<Show when={painted()}>
					<div
						ref={mirror}
						aria-hidden="true"
						class={`vim-mirror pointer-events-none absolute inset-0 overflow-hidden ${typography}`}
					>
						<For each={runs()}>
							{(run) => (
								<Show when={run.kind !== "plain"} fallback={run.text}>
									<span
										class={
											run.kind === "cursor" ? "vim-cursor" : "vim-selection"
										}
									>
										{run.text}
									</span>
								</Show>
							)}
						</For>
					</div>
				</Show>

				<textarea
					ref={area}
					aria-label={props.label}
					rows={props.singleLine ? 1 : undefined}
					class={`vim-area relative h-full w-full resize-none rounded-none border-0 bg-transparent outline-none ${typography}`}
					classList={{
						"vim-painted": painted(),
						"overflow-hidden": props.singleLine,
					}}
					spellcheck={false}
					autocomplete="off"
					onKeyDown={onKeyDown}
					onBeforeInput={onBeforeInput}
					onClick={syncCaretFromClick}
					onScroll={() => {
						if (mirror && area) mirror.scrollTop = area.scrollTop;
					}}
					onPaste={onPaste}
				/>
			</div>

			<Show when={matches().length > 0}>
				<ul class="max-h-40 shrink-0 overflow-y-auto border-t border-rule bg-card">
					<For each={matches()}>
						{(entry, index) => (
							<li>
								<button
									type="button"
									class="flex w-full items-baseline gap-3 px-3 py-1 text-left text-xs"
									classList={{
										"bg-obligation-bg text-ink": index() === highlight(),
										"hover:bg-neutral-bg": index() !== highlight(),
									}}
									onMouseDown={(e) => {
										e.preventDefault();
										accept(entry.email);
									}}
								>
									<span class="truncate-cell flex-1">
										{entry.name ?? entry.email}
									</span>
									<Show when={entry.name}>
										<span class="shrink-0 text-ink-3">{entry.email}</span>
									</Show>
								</button>
							</li>
						)}
					</For>
				</ul>
			</Show>

			<Show when={!props.singleLine}>
				<div class="flex shrink-0 items-center gap-3 border-t border-rule bg-paper-2 px-3 py-1 text-xs">
					<span
						class="rounded px-1.5 py-0.5 font-semibold uppercase"
						classList={{
							"bg-obligation text-paper": state().mode === "normal",
							"bg-proved text-paper": state().mode === "insert",
							"bg-blocking text-paper": state().mode === "visual",
						}}
					>
						{state().mode}
					</span>

					<span class="truncate-cell flex-1 text-ink-3">{props.label}</span>

					<span class="shrink-0 text-ink-3">
						{where().line}:{where().column}
					</span>

					<span class="shrink-0 text-ink-3">
						<kbd>ZZ</kbd> {props.submitLabel ?? "send"} · <kbd>ZQ</kbd> discard
					</span>

					{state().status && (
						<span class="shrink-0 mono text-obligation">{state().status}</span>
					)}
				</div>
			</Show>
		</div>
	);
}
