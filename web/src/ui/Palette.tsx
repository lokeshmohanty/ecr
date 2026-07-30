import { Show, createEffect } from "solid-js";
import type { AppStore } from "../state/store";

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
  const active = () => props.store.mode() === "command" || props.store.mode() === "search";
  const prefix = () => (props.store.mode() === "command" ? ":" : "/");

  createEffect(() => {
    if (active()) queueMicrotask(() => input?.focus());
  });

  const submit = () => {
    const value = props.store.palette();

    if (props.store.mode() === "search") {
      props.store.setQuery(value);
      props.store.setSelected(0);
    } else {
      const result = runCommand(value);
      if (result.query) {
        props.store.setQuery(result.query);
        props.store.setSelected(0);
      }
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

  return (
    <Show when={active()}>
      <div class="absolute inset-x-0 top-0 z-30 flex justify-center px-4 pt-16">
        <div class="flex w-full max-w-2xl items-center gap-2 rounded border border-accent bg-bg-panel px-3 py-2 shadow-2xl">
          <span class="text-accent">{prefix()}</span>
          <input
            ref={input}
            class="w-full border-0 bg-transparent p-0 text-text-primary outline-none"
            value={props.store.palette()}
            onInput={(e) => props.store.setPalette(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
          />
        </div>
      </div>
    </Show>
  );
}
