import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { handleKey, initialState, lineStart, position, type EditorState } from "../keymap/vim";
import {
  currentRecipientFragment,
  rankAddresses,
  replaceRecipientFragment,
  type AddressEntry,
} from "../state/suggest";

export interface VimEditorProps {
  initial: string;
  /** Shown in the status line, e.g. "reply · alice@example.com". */
  label: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onModeChange?: (mode: EditorState["mode"]) => void;
  submitLabel?: string;
  /** Enables To/Cc/Bcc completion. */
  addressBook?: AddressEntry[];
  startMode?: EditorState["mode"];
}

/**
 * A textarea driven entirely by the pure vim engine. The textarea keeps native
 * rendering, scrolling and selection, but every keystroke goes through
 * `handleKey` so the modal grammar is the same one the tests exercise.
 */
export function VimEditor(props: VimEditorProps) {
  let area: HTMLTextAreaElement | undefined;
  const [state, setState] = createSignal<EditorState>(
    initialState(props.initial, props.startMode ?? "normal"),
  );
  const [highlight, setHighlight] = createSignal(0);

  /** The recipient being typed, if the caret is on a To/Cc/Bcc line. */
  const recipient = createMemo(() => {
    if (!props.addressBook?.length) return null;
    const current = state();
    if (current.mode !== "insert") return null;

    const start = lineStart(current.text, current.caret);
    const end = current.text.indexOf("\n", start);
    const line = current.text.slice(start, end === -1 ? current.text.length : end);

    const fragment = currentRecipientFragment(line, current.caret - start);
    if (!fragment || fragment.fragment.length < 2) return null;

    return { ...fragment, lineStart: start, line };
  });

  const matches = createMemo(() => {
    const target = recipient();
    return target ? rankAddresses(props.addressBook ?? [], target.fragment) : [];
  });

  const accept = (email: string) => {
    const target = recipient();
    if (!target) return;

    setState((current) => {
      const replaced = replaceRecipientFragment(
        target.line,
        target.start,
        target.start + target.fragment.length,
        email,
      );
      const before = current.text.slice(0, target.lineStart);
      const after = current.text.slice(target.lineStart + target.line.length);

      return {
        ...current,
        text: before + replaced.text + after,
        caret: target.lineStart + replaced.caret,
      };
    });
    setHighlight(0);
  };

  // The editor takes the keyboard the moment it opens. Without this the
  // textarea is unfocused, every keystroke falls through to the app, and the
  // editor looks inert.
  onMount(() => {
    area?.focus({ preventScroll: true });
    const caret = state().caret;
    area?.setSelectionRange(caret, caret);
  });

  // Keep the DOM caret in step with the model after every change.
  createEffect(() => {
    const current = state();
    if (!area) return;
    if (area.value !== current.text) area.value = current.text;
    area.setSelectionRange(current.caret, current.caret);
    props.onModeChange?.(current.mode);
  });

  createEffect(() => {
    const current = state();
    if (current.submit) props.onSubmit(current.text);
    else if (current.cancel) props.onCancel();
  });

  const onKeyDown = (event: KeyboardEvent) => {
    // Chords stay with the browser and the OS.
    if (event.ctrlKey || event.metaKey || event.altKey) return;

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
      }),
    );
  };

  const syncCaretFromClick = () => {
    if (!area) return;
    const caret = area.selectionStart;
    setState((current) => ({ ...current, caret }));
  };

  onCleanup(() => props.onModeChange?.("normal"));

  const where = () => position(state().text, state().caret);

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <textarea
        ref={area}
        class="min-h-0 flex-1 resize-none rounded-none border-0 border-t border-border bg-bg-raised p-3 leading-relaxed outline-none"
        spellcheck={false}
        autocomplete="off"
        value={props.initial}
        onKeyDown={onKeyDown}
        onClick={syncCaretFromClick}
        onFocus={syncCaretFromClick}
      />

      <Show when={matches().length > 0}>
        <ul class="max-h-40 shrink-0 overflow-y-auto border-t border-border bg-bg-raised">
          <For each={matches()}>
            {(entry, index) => (
              <li>
                <button
                  type="button"
                  class="flex w-full items-baseline gap-3 px-3 py-1 text-left text-xs"
                  classList={{
                    "bg-bg-selected text-text-strong": index() === highlight(),
                    "hover:bg-bg-hover": index() !== highlight(),
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    accept(entry.email);
                  }}
                >
                  <span class="truncate-cell flex-1">{entry.name ?? entry.email}</span>
                  <Show when={entry.name}>
                    <span class="shrink-0 text-text-dim">{entry.email}</span>
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <div class="flex shrink-0 items-center gap-3 border-t border-border bg-bg-panel px-3 py-1 text-xs">
        <span
          class="rounded px-1.5 py-0.5 font-semibold uppercase"
          classList={{
            "bg-accent text-bg-raised": state().mode === "normal",
            "bg-tag-unread text-bg-raised": state().mode === "insert",
          }}
        >
          {state().mode}
        </span>

        <span class="truncate-cell flex-1 text-text-dim">{props.label}</span>

        <span class="shrink-0 text-text-dim">
          {where().line}:{where().column}
        </span>

        <span class="shrink-0 text-text-dim">
          <kbd>ZZ</kbd> {props.submitLabel ?? "send"} · <kbd>ZQ</kbd> discard
        </span>

        {state().pending && <span class="shrink-0 text-accent">{state().pending}</span>}
      </div>
    </div>
  );
}
