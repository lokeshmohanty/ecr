/**
 * The composer on a phone: a textarea, and nothing else.
 *
 * The vim editor is the point of this client on a desktop, and it stays there.
 * On a phone it is a liability — there are no keys to leave insert mode with,
 * a mode indicator names a state you cannot change, and every keystroke going
 * through a state machine costs the things a soft keyboard is good at:
 * autocorrect, swipe typing, the selection handles, the clipboard bar.
 *
 * So this takes the same props as `VimEditor` and answers them natively. What
 * a key did, a control now does: sending is the button on the bar, and leaving
 * is the back gesture.
 */
import { Show, createEffect, createSignal, onMount } from "solid-js";
import { rankAddresses, type AddressEntry } from "../state/suggest";
import type { VimEditorProps } from "./VimEditor";

export function PlainEditor(props: VimEditorProps) {
  let area: HTMLTextAreaElement | undefined;

  const [text, setText] = createSignal(props.initial);
  const [highlight, setHighlight] = createSignal(0);
  const [caret, setCaret] = createSignal(props.initial.length);

  createEffect(() => props.onChange?.(text()));

  // The host asks for the keyboard by marking one surface focused; an editor
  // that opens without focus reads as inert, on a phone doubly so because the
  // soft keyboard never appears.
  createEffect(() => {
    if (props.focused && area && document.activeElement !== area) area.focus();
  });

  onMount(() => {
    if (props.focused !== false) area?.focus();
  });

  /*
   * A header field holds a bare list — `ada@example.com, bo@example.com` — so
   * the fragment being completed is whatever follows the last comma before the
   * caret. There is no `to:` prefix here to find: the header is a DOM label,
   * which is what stops it being editable in the first place.
   */
  const fragment = () => {
    const before = text().slice(0, caret());
    const start = before.lastIndexOf(",") + 1;
    const raw = before.slice(start);
    return { start: start + (raw.length - raw.trimStart().length), text: raw.trim() };
  };

  const matches = (): AddressEntry[] => {
    if (!props.addressBook?.length || !props.singleLine) return [];
    const { text: needle } = fragment();
    // One or two characters match most of an address book, which is a list
    // rather than a suggestion.
    if (needle.length < 2) return [];
    return rankAddresses(props.addressBook, needle).slice(0, 6);
  };

  const accept = (email: string) => {
    const { start } = fragment();
    const next = `${text().slice(0, start)}${email}, `;
    setText(next);
    setHighlight(0);
    queueMicrotask(() => {
      if (!area) return;
      area.value = next;
      area.setSelectionRange(next.length, next.length);
      setCaret(next.length);
      area.focus();
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const list = matches();
    if (list.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      accept(list[highlight()]!.email);
      return;
    }
    if (list.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((h) => Math.min(Math.max(h + step, 0), list.length - 1));
      return;
    }

    // A header field is one line, so Return leaves it rather than growing it.
    if (props.singleLine && event.key === "Enter") {
      event.preventDefault();
      props.onNextField?.("insert");
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      if (event.shiftKey) props.onPreviousField?.("insert");
      else props.onNextField?.("insert");
    }
  };

  return (
    <div
      class="relative flex flex-col"
      classList={{ "min-h-0 flex-1": !props.singleLine, "shrink-0": props.singleLine }}
    >
      <textarea
        ref={area}
        aria-label={props.label}
        rows={props.singleLine ? 1 : undefined}
        value={text()}
        class="w-full resize-none rounded-none border-0 bg-transparent outline-none"
        classList={{
          "h-7 overflow-hidden px-2 py-0.5": props.singleLine,
          "min-h-0 flex-1 p-3 leading-relaxed": !props.singleLine,
        }}
        // Everything a soft keyboard is good at, which the vim surface has to
        // refuse: correction, capitals, and a keyboard shaped for the field.
        autocapitalize={props.singleLine ? "none" : "sentences"}
        autocomplete="off"
        spellcheck={!props.singleLine}
        enterkeyhint={props.singleLine ? "next" : undefined}
        onInput={(event) => {
          setText(event.currentTarget.value);
          setCaret(event.currentTarget.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onClick={(event) => setCaret(event.currentTarget.selectionStart)}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onPaste={(event) => {
          const files = [...(event.clipboardData?.items ?? [])]
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
          if (files.length > 0 && props.onPasteFiles) {
            event.preventDefault();
            props.onPasteFiles(files);
          }
        }}
      />

      <Show when={matches().length > 0}>
        <ul class="absolute top-full right-0 left-0 z-20 max-h-48 overflow-y-auto rounded border border-rule bg-paper-2 shadow-lg">
          {matches().map((entry, index) => (
            <li>
              <button
                type="button"
                class="touch-target flex w-full flex-col items-start px-3 py-1.5 text-left"
                classList={{ "bg-neutral-bg": index === highlight() }}
                // The textarea must not lose focus before the pick lands.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => accept(entry.email)}
              >
                <span class="truncate-cell max-w-full text-ink">{entry.name || entry.email}</span>
                <Show when={entry.name}>
                  <span class="truncate-cell mono max-w-full text-xs text-ink-3">
                    {entry.email}
                  </span>
                </Show>
              </button>
            </li>
          ))}
        </ul>
      </Show>
    </div>
  );
}
