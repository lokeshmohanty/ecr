import { For, Show, createSignal } from "solid-js";
import type { AppStore } from "../state/store";
import { DEFAULT_VIEWS } from "../state/store";

export function Sidebar(props: { store: AppStore; onCompose: () => void }) {
  const [expanded, setExpanded] = createSignal<string | null>(null);

  const isActive = (query: string) => props.store.query() === query;

  const select = (query: string) => {
    props.store.setQuery(query);
    props.store.setSelected(0);
    props.store.setOpenThread(null);
  };

  return (
    <nav class="flex h-full flex-col border-r border-border bg-bg-panel">
      <div class="scroll-y flex-1 px-3 py-3">
        <Section label="Views" />
        <For each={DEFAULT_VIEWS}>
          {(view) => (
            <button
              type="button"
              class="touch-target flex w-full items-center rounded px-2 py-1.5 text-left uppercase tracking-wide"
              classList={{
                "bg-bg-selected text-text-primary": isActive(view.query),
                "text-text-secondary hover:bg-bg-hover": !isActive(view.query),
              }}
              onClick={() => select(view.query)}
            >
              {view.name}
            </button>
          )}
        </For>

        <Section label="Accounts" />
        <For each={props.store.accounts() ?? []}>
          {(account) => (
            <div class="mb-1">
              <button
                type="button"
                class="touch-target flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-text-secondary hover:bg-bg-hover"
                onClick={() =>
                  setExpanded((current) => (current === account.id ? null : account.id))
                }
              >
                <span class="text-text-dim">
                  {expanded() === account.id ? "▾" : "▸"}
                </span>
                <span class="truncate-cell flex-1">{account.id}</span>
                <span class="text-xs text-text-dim">{account.folders.length}</span>
              </button>

              <Show when={expanded() === account.id}>
                <div class="ml-4 border-l border-border pl-2">
                  <For each={account.folders}>
                    {(folder) => {
                      const query = `path:"${folder.relative_path}/**"`;
                      return (
                        <button
                          type="button"
                          class="truncate-cell block w-full rounded px-2 py-1 text-left text-xs"
                          classList={{
                            "bg-bg-selected text-text-primary": isActive(query),
                            "text-text-dim hover:bg-bg-hover hover:text-text-secondary":
                              !isActive(query),
                          }}
                          title={folder.name}
                          onClick={() => select(query)}
                        >
                          {folder.name}
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>

      <div class="border-t border-border p-3">
        <button
          type="button"
          class="touch-target w-full rounded bg-accent px-3 py-2 font-semibold text-bg-main hover:opacity-90"
          onClick={props.onCompose}
        >
          + COMPOSE
        </button>
      </div>
    </nav>
  );
}

function Section(props: { label: string }) {
  return (
    <div class="mt-4 mb-1 px-2 text-xs uppercase tracking-widest text-text-dim first:mt-0">
      {props.label}
    </div>
  );
}
