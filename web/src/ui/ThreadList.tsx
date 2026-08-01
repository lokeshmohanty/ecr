import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { ThreadSummary } from "../api/types";
import type { AppStore } from "../state/store";
import { MARK_TAGS } from "../state/store";
import { windowRange } from "./window";

const ROW_HEIGHT = 58;

export function ThreadList(props: { store: AppStore }) {
  const [scroller, setScroller] = createSignal<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(0);

  const items = createMemo(() => props.store.items());

  const attach = (element: HTMLDivElement) => {
    setScroller(element);
    setViewport(element.clientHeight);

    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  };

  const range = createMemo(() =>
    windowRange(items().length, scrollTop(), viewport(), ROW_HEIGHT),
  );

  const visible = createMemo(() => {
    const { start, end } = range();
    return items()
      .slice(start, end)
      .map((thread, offset) => ({ thread, index: start + offset }));
  });

  createEffect(() => {
    const index = props.store.selected();
    const element = scroller();
    if (!element || items().length === 0) return;

    const top = index * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;

    if (top < element.scrollTop) {
      element.scrollTop = top;
    } else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
  });

  const focused = () => props.store.pane() === "list";

  return (
    <section
      class="pane h-full border-r border-rule"
      classList={{ "pane-focused": focused() }}
      onClick={() => props.store.setPane("list")}
    >
      <header class="row-grid shrink-0 border-b border-rule bg-paper-2 px-3 py-2 text-xs uppercase tracking-wide text-ink-3">
        <span />
        <span class="truncate-cell mono">{props.store.query()}</span>
        <span class="mono text-right">
          {items().length}/{props.store.threads()?.total ?? 0}
        </span>
      </header>

      <div
        ref={attach}
        class="scroll-y flex-1"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <Show
          when={items().length > 0}
          fallback={
            <div class="flex h-full items-center justify-center p-6 text-center">
              <Show
                when={!props.store.threads.loading}
                fallback={<span class="text-ink-3">loading…</span>}
              >
                <Show
                  when={props.store.lastError()}
                  fallback={<span class="text-ink-3">no matching threads</span>}
                >
                  {(error) => (
                    <div class="max-w-sm">
                      <p class="mb-2 text-blocking">cannot reach the server</p>
                      <p class="mb-3 text-xs break-words text-ink-3">{error()}</p>
                      <p class="mb-3 text-xs text-ink-3">
                        {props.store.connection().baseUrl || "no server url configured"}
                      </p>
                      <button
                        type="button"
                        class="touch-target rounded border border-rule px-3 py-1.5 text-obligation hover:bg-neutral-bg"
                        onClick={() => props.store.bumpRevision()}
                      >
                        retry
                      </button>
                    </div>
                  )}
                </Show>
              </Show>
            </div>
          }
        >
          <div style={{ height: `${range().total}px`, position: "relative" }}>
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${range().offset}px)`,
              }}
            >
              <For each={visible()}>
                {(entry) => (
                  <Row thread={entry.thread} index={entry.index} store={props.store} />
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
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
      class="row-grid touch-target cursor-pointer border-b border-rule-soft px-3 py-2"
      style={{ height: `${ROW_HEIGHT}px` }}
      classList={{
        "bg-obligation-bg text-ink": selected(),
        "hover:bg-neutral-bg": !selected(),
      }}
      onClick={() => {
        props.store.setSelected(props.index);
        props.store.setOpenThread(props.thread.id);
        props.store.leaveRightPane();
        props.store.setMessageIndex(0);
      }}
    >
      {/* The margin tape: the row's state as a rule rather than a badge. */}
      <span
        class="tape"
        classList={{
          "tape-marked": badges() !== "",
          "tape-unread": badges() === "" && unread(),
          "tape-flagged": badges() === "" && !unread() && flagged(),
        }}
        title={badges() || (unread() ? "unread" : flagged() ? "flagged" : "")}
      />

      <div class="min-w-0">
        <div
          class="truncate-cell"
          classList={{
            "text-ink font-semibold": unread(),
            "text-ink-2": !unread(),
          }}
        >
          {props.thread.authors.join(", ") || "(no sender)"}
        </div>
        <div class="truncate-cell text-ink-3">
          {props.thread.subject || "(no subject)"}
        </div>
      </div>

      <div class="mono text-right text-xs text-ink-3">
        <div>{props.thread.date_relative}</div>
        <Show when={props.thread.total > 1}>
          <div class="text-proved">({props.thread.total})</div>
        </Show>
      </div>
    </div>
  );
}
