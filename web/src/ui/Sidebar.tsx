import { For, Show, createEffect } from "solid-js";
import type { AppStore } from "../state/store";
import { ALL_ACCOUNTS } from "../state/views";

export function Sidebar(props: { store: AppStore; onCompose: () => void; onSettings: () => void }) {
  let scroller: HTMLDivElement | undefined;

  const focused = () => props.store.pane() === "sidebar";
  const rows = () => props.store.sidebarRows();

  createEffect(() => {
    const index = props.store.sidebarIndex();
    if (!focused() || !scroller) return;
    scroller.querySelector<HTMLElement>(`[data-row="${index}"]`)?.scrollIntoView({
      block: "nearest",
    });
  });

  const activate = (index: number) => {
    props.store.setSidebarIndex(index);
    props.store.setPane("sidebar");
    props.store.activateSidebar();
  };

  return (
    <nav
      class="pane h-full border-r border-border bg-bg-panel"
      classList={{ "pane-focused": focused() }}
      onClick={() => props.store.setPane("sidebar")}
    >
      <div ref={scroller} class="scroll-y flex-1 px-2 py-2">
        <For each={rows()}>
          {(row, index) => {
            const active = () => props.store.query() === row.query;
            const cursor = () => focused() && props.store.sidebarIndex() === index();
            const expanded = () => props.store.expandedGroup() === row.group;

            return (
              <Show
                when={row.kind === "group"}
                fallback={
                  <button
                    type="button"
                    data-row={index()}
                    class="truncate-cell block w-full rounded py-1 pr-2 pl-6 text-left text-xs uppercase tracking-wide"
                    classList={{
                      "bg-bg-selected text-text-strong": active(),
                      "text-text-secondary hover:bg-bg-hover": !active(),
                      "ring-1 ring-accent": cursor(),
                    }}
                    onClick={() => activate(index())}
                  >
                    {row.name}
                  </button>
                }
              >
                <button
                  type="button"
                  data-row={index()}
                  class="mt-2 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left first:mt-0"
                  classList={{
                    "text-text-strong": expanded(),
                    "text-text-dim hover:bg-bg-hover": !expanded(),
                    "ring-1 ring-accent": cursor(),
                  }}
                  onClick={() => activate(index())}
                >
                  <span class="shrink-0 text-text-dim">{expanded() ? "▾" : "▸"}</span>
                  <span class="truncate-cell flex-1 uppercase tracking-widest">
                    {row.name === ALL_ACCOUNTS ? "All accounts" : row.name}
                  </span>
                </button>
              </Show>
            );
          }}
        </For>
      </div>

      <div class="shrink-0 space-y-2 border-t border-border p-2">
        <button
          type="button"
          class="touch-target w-full rounded bg-accent px-3 py-2 font-semibold text-bg-raised hover:opacity-90"
          onClick={props.onCompose}
        >
          + COMPOSE
        </button>
        <button
          type="button"
          class="touch-target flex w-full items-center justify-center gap-2 rounded border border-border px-3 py-1.5 text-text-secondary hover:bg-bg-hover"
          onClick={props.onSettings}
          title="Settings (,)"
        >
          ⚙ SETTINGS
        </button>
      </div>
    </nav>
  );
}
