import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { AppStore } from "../state/store";
import { suggestQuery } from "../state/suggest";

export interface CommandResult {
  query?: string;
  status?: string;
  sync?: boolean;
  quit?: boolean;
}

/** Pure so the command grammar can be tested without a DOM. */
export function runCommand(input: string): CommandResult {
  const trimmed = input.trim();
  if (trimmed === "") return {};

  const [name, ...rest] = trimmed.split(/\s+/);
  const argument = rest.join(" ");

  switch (name) {
    case "q":
    case "quit":
      return { quit: true };
    case "sync":
    case "w":
      return { sync: true };
    case "search":
    case "s":
      return argument ? { query: argument } : { status: "usage: :search <query>" };
    case "inbox":
      return { query: "tag:inbox" };
    case "unread":
      return { query: "tag:unread" };
    case "flagged":
      return { query: "tag:flagged" };
    case "all":
      return { query: "*" };
    default:
      return { status: `unknown command: ${name}` };
  }
}

export function Palette(props: { store: AppStore }) {
  let input: HTMLInputElement | undefined;
  const [highlight, setHighlight] = createSignal(0);

  const active = () => props.store.mode() === "command" || props.store.mode() === "search";
  const searching = () => props.store.mode() === "search";
  const prefix = () => (searching() ? "/" : ":");

  /** `/` is a notmuch query prompt, so it completes tags and search prefixes. */
  const suggestions = createMemo(() =>
    searching() ? suggestQuery(props.store.palette(), props.store.allTags() ?? []) : [],
  );

  createEffect(() => {
    if (active()) queueMicrotask(() => input?.focus());
  });

  createEffect(() => {
    props.store.palette();
    setHighlight(0);
  });

  const apply = (value: string) => {
    props.store.setQuery(value);
    props.store.setSelected(0);
    props.store.followSelection(0);
  };

  const submit = () => {
    const chosen = suggestions()[highlight()];
    const value = searching() && chosen ? chosen.value : props.store.palette();

    if (searching()) {
      apply(value);
    } else {
      const result = runCommand(value);
      if (result.query) apply(result.query);
      if (result.sync) void props.store.sync();
      if (result.status) props.store.setStatus(result.status);
    }

    props.store.setPalette("");
    props.store.setMode("normal");
  };

  const cancel = () => {
    props.store.setPalette("");
    props.store.setMode("normal");
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const list = suggestions();

    if (event.key === "Tab" && list.length > 0) {
      event.preventDefault();
      props.store.setPalette(list[highlight()]!.value);
      return;
    }
    if ((event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) && list.length > 0) {
      event.preventDefault();
      setHighlight((h) => Math.min(h + 1, list.length - 1));
      return;
    }
    if ((event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) && list.length > 0) {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  return (
    <Show when={active()}>
      <div class="absolute inset-x-0 top-0 z-30 flex justify-center px-4 pt-16">
        <div class="w-full max-w-2xl overflow-hidden rounded border border-obligation bg-card shadow-2xl">
          <div class="flex items-center gap-2 px-3 py-2">
            <span class="text-obligation">{prefix()}</span>
            <input
              ref={input}
              aria-label={searching() ? "search query" : "command"}
              class="w-full border-0 bg-transparent p-0 text-ink outline-none"
              placeholder={searching() ? "notmuch query, e.g. tag:unread and from:alice" : "command"}
              value={props.store.palette()}
              onInput={(e) => props.store.setPalette(e.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
          </div>

          <Show when={suggestions().length > 0}>
            <ul class="max-h-72 overflow-y-auto border-t border-rule-soft">
              <For each={suggestions()}>
                {(suggestion, index) => (
                  <li>
                    <button
                      type="button"
                      class="flex w-full items-baseline gap-3 px-3 py-1.5 text-left"
                      classList={{
                        "bg-obligation-bg text-ink": index() === highlight(),
                        "hover:bg-neutral-bg": index() !== highlight(),
                      }}
                      onMouseEnter={() => setHighlight(index())}
                      onClick={() => {
                        props.store.setPalette(suggestion.value);
                        submit();
                      }}
                    >
                      <span class="truncate-cell flex-1">{suggestion.label}</span>
                      <span class="shrink-0 text-xs text-ink-3">{suggestion.detail}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <div class="border-t border-rule-soft px-3 py-1 text-xs text-ink-3">
              <kbd>Tab</kbd> complete · <kbd>↑↓</kbd> choose · <kbd>Enter</kbd> run
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
