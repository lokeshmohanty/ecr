import { For, Show, createEffect, createMemo } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type { ThreadSummary } from "../api/types";
import type { AppStore } from "../state/store";
import { MARK_TAGS } from "../state/store";

const ROW_HEIGHT = 58;

export function ThreadList(props: { store: AppStore }) {
  let scroller: HTMLDivElement | undefined;

  const items = createMemo(() => props.store.items());

  const virtualizer = createVirtualizer({
    get count() {
      return items().length;
    },
    getScrollElement: () => scroller ?? null,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  createEffect(() => {
    const index = props.store.selected();
    if (items().length > 0) virtualizer.scrollToIndex(index, { align: "auto" });
  });

  return (
    <section class="flex h-full min-w-0 flex-col border-r border-border">
      <header class="row-grid border-b border-border px-3 py-2 text-xs uppercase tracking-wide text-text-dim">
        <span />
        <span class="truncate-cell">{props.store.query()}</span>
        <span class="text-right">
          {items().length}/{props.store.threads()?.total ?? 0}
        </span>
      </header>

      <Show
        when={items().length > 0}
        fallback={
          <div class="flex flex-1 items-center justify-center text-text-dim">
            {props.store.threads.loading ? "loading…" : "no matching threads"}
          </div>
        }
      >
        <div ref={scroller} class="scroll-y flex-1">
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
            <For each={virtualizer.getVirtualItems()}>
              {(virtual) => {
                const thread = () => items()[virtual.index]!;
                return (
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: `${virtual.size}px`,
                      transform: `translateY(${virtual.start}px)`,
                    }}
                  >
                    <Row
                      thread={thread()}
                      index={virtual.index}
                      store={props.store}
                    />
                  </div>
                );
              }}
            </For>
          </div>
        </div>
      </Show>
    </section>
  );
}

function Row(props: { thread: ThreadSummary; index: number; store: AppStore }) {
  const selected = () => props.store.selected() === props.index;
  const unread = () => props.thread.tags.includes("unread");
  const flagged = () => props.thread.tags.includes("flagged");

  const badges = () => {
    const id = props.thread.newest_message;
    if (!id) return "";
    return (props.store.marks[id] ?? []).map((m) => MARK_TAGS[m].badge).join("");
  };

  return (
    <div
      class="row-grid touch-target cursor-pointer border-b border-border/60 px-3 py-2"
      classList={{
        "bg-bg-selected": selected(),
        "hover:bg-bg-hover": !selected(),
      }}
      onClick={() => {
        props.store.setSelected(props.index);
        props.store.setOpenThread(props.thread.id);
      }}
    >
      <span class="text-xs" classList={{ "text-star": flagged() }}>
        <Show when={badges()} fallback={flagged() ? "★" : unread() ? "●" : ""}>
          <span class="text-tag-urgent">{badges()}</span>
        </Show>
      </span>

      <div class="min-w-0">
        <div
          class="truncate-cell"
          classList={{
            "text-text-primary font-semibold": unread(),
            "text-text-secondary": !unread(),
          }}
        >
          {props.thread.authors.join(", ") || "(no sender)"}
        </div>
        <div class="truncate-cell text-text-dim">
          {props.thread.subject || "(no subject)"}
        </div>
      </div>

      <div class="text-right text-xs text-text-dim">
        <div>{props.thread.date_relative}</div>
        <Show when={props.thread.total > 1}>
          <div class="text-accent-dim">({props.thread.total})</div>
        </Show>
      </div>
    </div>
  );
}
