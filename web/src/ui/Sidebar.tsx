import { For, Show, createEffect } from "solid-js";
import type { AppStore } from "../state/store";
import { DEFAULT_VIEWS } from "../state/store";

export function Sidebar(props: { store: AppStore; onCompose: () => void; onSettings: () => void }) {
  let scroller: HTMLDivElement | undefined;

  const focused = () => props.store.pane() === "sidebar";
  const isActive = (query: string) => props.store.query() === query;
  const cursorAt = (index: number) => focused() && props.store.sidebarIndex() === index;

  // Follow the keyboard cursor when it leaves the visible area.
  createEffect(() => {
    const index = props.store.sidebarIndex();
    if (!focused() || !scroller) return;
    const row = scroller.querySelector<HTMLElement>(`[data-row="${index}"]`);
    row?.scrollIntoView({ block: "nearest" });
  });

  const select = (query: string, index: number) => {
    props.store.setSidebarIndex(index);
    props.store.selectQuery(query);
  };

  return (
    <nav
      class="pane h-full border-r border-border bg-bg-panel"
      classList={{ "pane-focused": focused() }}
      onClick={() => props.store.setPane("sidebar")}
    >
      <div ref={scroller} class="scroll-y flex-1 px-2 py-3">
        <Section label="Views" />
        <For each={DEFAULT_VIEWS}>
          {(view, index) => (
            <Row
              label={view.name}
              index={index()}
              active={isActive(view.query)}
              cursor={cursorAt(index())}
              onSelect={() => select(view.query, index())}
            />
          )}
        </For>

        <Section label="Accounts" />
        <For each={props.store.accounts() ?? []}>
          {(account, position) => {
            const index = () => DEFAULT_VIEWS.length + position();
            const expanded = () => props.store.expandedAccount() === account.id;

            return (
              <div>
                <Row
                  label={account.id}
                  index={index()}
                  active={isActive(`tag:${account.id}`)}
                  cursor={cursorAt(index())}
                  marker={expanded() ? "▾" : "▸"}
                  trailing={String(account.folders.length)}
                  onSelect={() => {
                    props.store.setExpandedAccount(expanded() ? null : account.id);
                    select(`tag:${account.id}`, index());
                  }}
                />

                <Show when={expanded()}>
                  <div class="ml-3 border-l border-border-soft pl-2">
                    <For each={account.folders}>
                      {(folder) => {
                        const query = `path:"${folder.relative_path}/**"`;
                        return (
                          <button
                            type="button"
                            class="truncate-cell block w-full rounded px-2 py-1 text-left text-xs"
                            classList={{
                              "bg-bg-selected text-text-strong": isActive(query),
                              "text-text-dim hover:bg-bg-hover": !isActive(query),
                            }}
                            title={folder.name}
                            onClick={() => props.store.selectQuery(query)}
                          >
                            {folder.name}
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </div>
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

function Row(props: {
  label: string;
  index: number;
  active: boolean;
  cursor: boolean;
  marker?: string;
  trailing?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-row={props.index}
      class="touch-target flex w-full items-center gap-2 rounded px-2 py-1.5 text-left uppercase tracking-wide"
      classList={{
        "bg-bg-selected text-text-strong": props.active,
        "text-text-secondary hover:bg-bg-hover": !props.active,
        "ring-1 ring-accent": props.cursor,
      }}
      onClick={props.onSelect}
    >
      <Show when={props.marker}>
        <span class="shrink-0 text-text-dim">{props.marker}</span>
      </Show>
      <span class="truncate-cell flex-1">{props.label}</span>
      <Show when={props.trailing}>
        <span class="shrink-0 text-xs text-text-dim">{props.trailing}</span>
      </Show>
    </button>
  );
}

function Section(props: { label: string }) {
  return (
    <div class="mt-4 mb-1 px-2 text-xs uppercase tracking-widest text-text-dim first:mt-0">
      {props.label}
    </div>
  );
}
