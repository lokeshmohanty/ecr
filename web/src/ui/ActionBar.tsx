/**
 * The phone's bottom bar.
 *
 * On a desktop the status line is a vim status line, and every action is a key.
 * A phone has no keys, so the same strip becomes the actions themselves — the
 * ones that belong to the pane you are looking at, as buttons big enough to hit.
 * Nothing here is new behaviour: each button is the store call the keybinding
 * already made, so the two ways in cannot drift apart.
 */
import { For } from "solid-js";
import type { AppStore } from "../state/store";
import type { Mark } from "../state/store/marks";

interface Action {
  label: string;
  glyph: string;
  run: () => void;
  /** Shown pressed, for the one action that is a state rather than an event. */
  active?: () => boolean;
}

export function ActionBar(props: {
  store: AppStore;
  onCompose: () => void;
  onReply: (all: boolean) => void;
  onSaveQuery: () => void;
}) {
  const selecting = () => props.store.selectionMode();

  /*
   * Staged and written in one go. Staging exists so a desktop can queue many
   * changes and read them back before `x` writes them; a thumb on a button
   * means one row and one intention, and leaving it staged would be a change
   * the person cannot see they still owe.
   */
  const apply = (mark: Mark) => {
    props.store.mark(mark);
    void props.store.executeMarks();
  };

  const listActions = (): Action[] => [
    { label: "Archive", glyph: "⤓", run: () => apply("archive") },
    { label: "Flag", glyph: "⚑", run: () => apply("flag") },
    { label: "Read", glyph: "◍", run: () => apply("read") },
    { label: "Delete", glyph: "✕", run: () => apply("delete") },
    {
      label: selecting() ? "Done" : "Select",
      glyph: selecting() ? "✓" : "☑",
      run: () => props.store.setSelectionMode(!selecting()),
      active: selecting,
    },
  ];

  const detailActions = (): Action[] => [
    { label: "Reply", glyph: "↩", run: () => props.onReply(false) },
    { label: "Reply all", glyph: "↰", run: () => props.onReply(true) },
    { label: "Archive", glyph: "⤓", run: () => apply("archive") },
    { label: "Flag", glyph: "⚑", run: () => apply("flag") },
    { label: "Delete", glyph: "✕", run: () => apply("delete") },
  ];

  const actions = (): Action[] => {
    switch (props.store.pane()) {
      case "detail":
        return detailActions();
      case "sidebar":
        return [
          { label: "Compose", glyph: "✎", run: props.onCompose },
          { label: "Save query", glyph: "◆", run: props.onSaveQuery },
        ];
      default:
        return listActions();
    }
  };

  return (
    <nav
      class="chrome-bottom flex items-stretch justify-around gap-1 border-t border-rule bg-paper-2 px-1 md:hidden"
      aria-label="actions"
    >
      <For each={actions()}>
        {(action) => (
          <button
            type="button"
            class="touch-target flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded px-1 py-1 text-ink-2 active:bg-neutral-bg"
            classList={{ "bg-obligation-bg text-ink": action.active?.() }}
            onClick={action.run}
            aria-pressed={action.active ? action.active() : undefined}
          >
            <span aria-hidden="true" class="text-base leading-none">
              {action.glyph}
            </span>
            <span class="truncate-cell max-w-full text-[10px] leading-none">{action.label}</span>
          </button>
        )}
      </For>
    </nav>
  );
}
