import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { ThreadSummary } from "../api/types";
import type { AppStore } from "../state/store";
import { badgesFor } from "../state/store";
import { formatListDate } from "../state/datetime";
import { windowRange } from "./window";
import { isNarrow } from "./narrow";
import { LONG_PRESS, drag, stillPressing, type Swipe } from "./row-gesture";

const ROW_HEIGHT = 58;

export function ThreadList(props: { store: AppStore; onCompose: () => void }) {
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
      class="pane relative h-full border-r border-rule"
      classList={{ "pane-focused": focused() }}
      /* On capture, so a row opening a thread has the last word. */
      oncapture:click={() => props.store.setPane("list")}
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
        // Room for the compose button to sit over, so the last thread in the
        // list is never the one hidden under it.
        classList={{ "max-md:pb-20": true }}
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

      {/*
        Compose is `c` on a desktop and the sidebar's button on any screen, but
        on a phone the sidebar is a place you have to travel to — and writing a
        message is the one thing you should never have to travel for.
      */}
      <button
        type="button"
        class="absolute right-4 bottom-4 flex size-14 items-center justify-center rounded-full bg-obligation text-xl text-paper shadow-lg md:hidden"
        onClick={(event) => {
          event.stopPropagation();
          props.onCompose();
        }}
        aria-label="Compose"
      >
        ✎
      </button>
    </section>
  );
}

function Row(props: { thread: ThreadSummary; index: number; store: AppStore }) {
  const selected = () => props.store.selected() === props.index;
  const unread = () => props.thread.tags.includes("unread");
  const flagged = () => props.thread.tags.includes("flagged");

  const badges = () => {
    const id = props.thread.newest_message;
    return id ? badgesFor(props.store.marks[id]) : "";
  };

  const picked = () => props.store.isSelected(props.index);

  // Falls back to notmuch's own phrasing when the server sent no timestamp, so
  // an older server still shows something rather than an empty column.
  const when = () => {
    const preferences = props.store.settings().preferences;
    return (
      formatListDate(props.thread.timestamp, preferences.listDateFormat, preferences.timezone) ||
      props.thread.date_relative
    );
  };

  const open = () => {
    props.store.setSelected(props.index);
    props.store.setOpenThread(props.thread.id);
    props.store.leaveRightPane();
    props.store.setMessageIndex(0);

    // A phone shows one pane, so opening a thread has to show it — exactly
    // what Enter does. On a desktop the thread is already beside the list
    // and focus deliberately stays here.
    if (isNarrow()) props.store.setPane("detail");
  };

  const [offset, setOffset] = createSignal(0);
  const [pending, setPending] = createSignal<Swipe>(null);
  let start: { x: number; y: number } | null = null;
  let sliding = false;
  let held = false;
  let moved = false;
  /** Whether this press is what turned selection mode on, so it can be undone. */
  let enteredMode = false;
  let holdTimer: number | undefined;

  const endHold = () => {
    if (holdTimer !== undefined) clearTimeout(holdTimer);
    holdTimer = undefined;
  };

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    start = { x: touch.clientX, y: touch.clientY };
    sliding = false;
    held = false;
    moved = false;
    enteredMode = false;

    // A press that rests picks the row, which is what Space does on a desktop.
    // The guard matters: touch events are delivered in batches, so a swipe that
    // crosses this deadline can have its movement arrive *after* the timer, and
    // a flick would otherwise both archive the row and put the list into
    // selection mode.
    holdTimer = window.setTimeout(() => {
      if (moved) return;
      held = true;
      enteredMode = !props.store.selectionMode();
      props.store.setSelectionMode(true);
      props.store.setSelected(props.index);
      props.store.toggleSelect();
    }, LONG_PRESS);
  };

  const onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch || !start) return;

    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (!stillPressing(dx, dy)) {
      moved = true;
      endHold();
    }

    // Swiping a row you are picking would be two answers to one gesture.
    if (held || props.store.selectionMode()) return;

    const move = drag(dx, dy);
    if (!move.horizontal) return;

    sliding = true;
    setOffset(move.offset);
    setPending(move.commit);
    // The row has claimed the gesture, so the list must stop scrolling under it.
    if (event.cancelable) event.preventDefault();
  };

  const onTouchEnd = () => {
    endHold();
    const commit = pending();
    setOffset(0);
    setPending(null);
    start = null;

    if (!sliding) return;
    sliding = false;

    // The press was long enough to fire the hold and then turned into a swipe.
    // One gesture, one meaning: the swipe wins, and the mode it opened closes.
    if (held) {
      props.store.toggleSelect();
      if (enteredMode) props.store.setSelectionMode(false);
      held = false;
    }

    if (commit) {
      // One row, one intention: staged and written, not left owing.
      props.store.setSelected(props.index);
      props.store.mark(commit === "archive" ? "archive" : "flag");
      void props.store.executeMarks();
    }
  };

  return (
    <div
      class="row-grid touch-target relative cursor-pointer border-b border-rule-soft px-3 py-2"
      style={{
        height: `${ROW_HEIGHT}px`,
        transform: offset() === 0 ? undefined : `translateX(${offset()}px)`,
        // Sliding sideways must not also drag the row out of the list.
        "touch-action": "pan-y",
      }}
      classList={{
        "bg-obligation-bg text-ink": selected(),
        "bg-neutral-bg": !selected() && picked(),
        "hover:bg-neutral-bg": !selected(),
      }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      onContextMenu={(event) => {
        // The long press already picked the row; the menu on top of it is the
        // browser answering the same gesture a second time.
        if (isNarrow()) event.preventDefault();
      }}
      onClick={() => {
        // The press that picked this row must not also open it.
        if (held) {
          held = false;
          return;
        }
        if (props.store.selectionMode()) {
          props.store.setSelected(props.index);
          props.store.toggleSelect();
          return;
        }
        open();
      }}
    >
      {/*
        What lifting the finger now would do. Shown on the edge the row is
        moving away from, so it is uncovered by the movement itself.
      */}
      <Show when={pending()}>
        <span
          aria-hidden="true"
          class="absolute top-0 flex h-full items-center px-3 text-lg"
          classList={{
            "right-0 -mr-12 text-obligation": pending() === "archive",
            "left-0 -ml-12 text-proved": pending() === "flag",
          }}
        >
          {pending() === "archive" ? "⤓" : "⚑"}
        </span>
      </Show>

      {/* The margin tape: the row's state as a rule rather than a badge. */}
      <span
        class="tape"
        classList={{
          "tape-marked": badges() !== "",
          "tape-selected": badges() === "" && picked(),
          "tape-unread": badges() === "" && !picked() && unread(),
          "tape-flagged": badges() === "" && !picked() && !unread() && flagged(),
        }}
        title={badges() || (picked() ? "selected" : unread() ? "unread" : flagged() ? "flagged" : "")}
      />

      {/* What is staged, so it can be read before x writes it. */}
      <Show when={badges()}>
        <span class="mono absolute left-6 text-[10px] text-blocking">{badges()}</span>
      </Show>

      <div class="flex min-w-0 items-center gap-2">
        <Show when={props.store.selectionMode()}>
          <span
            aria-hidden="true"
            class="flex size-5 shrink-0 items-center justify-center rounded border text-xs"
            classList={{
              "border-obligation bg-obligation text-paper": picked(),
              "border-rule text-transparent": !picked(),
            }}
          >
            ✓
          </span>
        </Show>

        <div class="min-w-0 flex-1">
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
      </div>

      <div class="mono text-right text-xs text-ink-3">
        <div title={props.thread.date_relative}>{when()}</div>
        <Show when={props.thread.total > 1}>
          <div class="text-proved">({props.thread.total})</div>
        </Show>
      </div>
    </div>
  );
}
