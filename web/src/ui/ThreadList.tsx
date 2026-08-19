import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import type { ThreadSummary } from "../api/types";
import { isOffline } from "../state/offline";
import type { AppStore } from "../state/store";
import { badgesFor } from "../state/store";
import { formatListDate, type Span } from "../state/datetime";
import { entryAt, offsetsOf, windowSlice } from "./window";
import { entriesOf, listGroups } from "../state/list-groups";
import { createDelayed } from "./delayed";
import { isNarrow, PHONE_MAX, viewportWidth } from "./narrow";
import { accountKeys, accountOf, type AccountKey } from "../state/account-keys";
import { ALL_ACCOUNTS } from "../state/views";
import { LONG_PRESS, drag, stillPressing, type Swipe } from "./row-gesture";
import { Outbox } from "./Outbox";

// Every row occupies exactly this much of the column, and the virtual
// scroller's arithmetic is built on that — the height below is set from these
// constants, so the two cannot drift. A row is one line: the subject, and the
// furniture that fits beside it.
//
// The gap is part of the pitch rather than a margin on top of it: a margin the
// scroller does not know about puts every row a little lower than
// `index * rowHeight()` says it is, and the error compounds down the list until
// the wrong thread is scrolled to.
const ROW_GAP = 6;

/** The card beside a pointer: one line of subject and its padding. */
const CARD = 32;

/**
 * The card under a thumb.
 *
 * A row carries `touch-target`, which is `min-height: 44px` below `md` — and
 * min-height wins over the inline height, so a 32px card on a phone is drawn
 * at 44 while the scroller still counts 38. That is twelve pixels of error a
 * row, compounding down the list until the row under the cursor is not the row
 * the arithmetic named. The pitch follows the card rather than the card being
 * clamped behind the pitch's back.
 */
const TOUCH_CARD = 44;

const cardHeight = () => (viewportWidth() <= PHONE_MAX ? TOUCH_CARD : CARD);
const rowHeight = () => cardHeight() + ROW_GAP;

/**
 * A heading, and the band the pinned copy of one occupies.
 *
 * One number for both: the heading that sticks to the top edge is the same
 * height as the ones in the flow, so a heading sliding under it is exactly
 * replaced rather than half-covered.
 */
const HEADING_HEIGHT = 26;

/**
 * What the date column of a row says.
 *
 * `span` is the granularity of the heading above it, and the row prints what
 * that heading did not: the clock under *Today*, the weekday and day under
 * *August*, the day and month under *2025*. Under no heading at all it is the
 * whole adaptive date.
 *
 * Falls back to notmuch's own phrasing when the server sent no timestamp, so
 * an older server still shows something rather than an empty column. Lifted out
 * of the row because the pane measures the widest one to size the track, and a
 * probe formatting dates by a second route would size the column for a string
 * no row is going to print.
 */
function dateOf(thread: ThreadSummary, store: AppStore, span?: Span): string {
  const preferences = store.settings().preferences;
  return (
    formatListDate(
      thread.timestamp,
      preferences.listDateFormat,
      preferences.timezone,
      undefined,
      span,
    ) || thread.date_relative
  );
}

/**
 * Whether the webfonts have arrived, as a signal.
 *
 * The date column is measured, and it is measured in a monospaced face that
 * loads over the network — so a measurement taken before it lands sizes the
 * track for the fallback and leaves it wrong for the life of the page. One
 * promise for the module, because there is one list.
 */
const [fontsReady, setFontsReady] = createSignal(false);
if (typeof document !== "undefined" && document.fonts)
  void document.fonts.ready.then(() => setFontsReady(true));

export function ThreadList(props: { store: AppStore; onCompose: () => void }) {
  const [scroller, setScroller] = createSignal<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(0);
  const [probe, setProbe] = createSignal<HTMLDivElement | null>(null);
  const [dateWidth, setDateWidth] = createSignal(0);

  const items = createMemo(() => props.store.items());

  /*
   * Only a wait long enough to be worth reporting. The list holds the previous
   * page across a refetch now, so this is reached only when there is genuinely
   * nothing to show — a first load, or a query that matches nothing — and even
   * then a fetch that lands inside the threshold should swap content rather
   * than blink a word at the reader.
   */
  const settling = createDelayed(() => props.store.threads.loading);

  const attach = (element: HTMLDivElement) => {
    setScroller(element);
    setViewport(element.clientHeight);

    // A line of this pane is a row, and the row's pitch is the same constant
    // the virtual scroller counts in — so a chord and the arithmetic under it
    // cannot disagree about where the next row starts.
    props.store.setPaneScroller("list", element, rowHeight);
    onCleanup(() => props.store.setPaneScroller("list", null));

    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  };

  /*
   * The list is threads *and* the day headings between them, so what is drawn
   * is `entries` rather than `items` — and the two must not be confused: a
   * thread keeps the index it has in `items`, which is what the cursor, the
   * selection and every tag operation are counted in.
   *
   * `now` is read once per page rather than per row, so a list rendered as
   * midnight passes cannot put half its rows under *Today* and half under a
   * date.
   */
  const groups = createMemo(() =>
    listGroups(items(), props.store.settings().preferences.timezone),
  );
  const entries = createMemo(() => entriesOf(items(), groups()));

  const heights = createMemo(() =>
    entries().map((entry) => (entry.kind === "heading" ? HEADING_HEIGHT : rowHeight())),
  );

  const offsets = createMemo(() => offsetsOf(heights()));

  /*
   * The date track is sized to the dates that are actually on screen.
   *
   * `--date-column` was a constant wide enough for the longest form the
   * adaptive format can produce — `01 Apr 14:30` — which is what a page of
   * mail from last year looks like. A page of mail from today is all `22:03`,
   * and the column went on holding room for seven characters nothing was going
   * to print while the subject beside it truncated mid-word.
   *
   * The widest is picked by *character count*, which is exact rather than
   * approximate: the cell is monospaced, so more characters is always wider.
   * What it is worth in pixels is a question only the browser can answer, and
   * only once the webfont has loaded, so a hidden copy of the cell is rendered
   * and measured. That copy is the same component the rows use — a probe built
   * out of its own markup would size the column for a cell that does not exist.
   */
  const widestDate = createMemo(() =>
    entries().reduce((widest, entry) => {
      if (entry.kind !== "thread") return widest;
      const date = dateOf(entry.thread, props.store, entry.span);
      return date.length > widest.length ? date : widest;
    }, ""),
  );

  const anyAttachment = createMemo(() =>
    items().some((thread) => thread.tags.includes("attachment")),
  );

  createEffect(() => {
    // Named rather than inferred: the effect has to re-run when the strings
    // change *and* when the font they are drawn in arrives.
    widestDate();
    anyAttachment();
    fontsReady();

    const element = probe();
    if (!element) return;

    // Rounded up, because a fractional track leaves the last character of the
    // widest date a subpixel short of its own column and Chromium ellipsizes it.
    const width = Math.ceil(element.getBoundingClientRect().width);
    if (width > 0) setDateWidth(width);
  });

  const range = createMemo(() =>
    windowSlice(offsets(), scrollTop(), viewport()),
  );

  /**
   * Where a thread's row starts, counting the headings above it.
   *
   * The cursor is an index into `items`, and the offset it needs is the entry's
   * — off by one heading per day above it otherwise, which at the bottom of a
   * long list is several rows of error.
   */
  const topOf = (index: number): number => {
    const at = entries().findIndex(
      (entry) => entry.kind === "thread" && entry.index === index,
    );
    return at < 0 ? 0 : offsets()[at]!;
  };

  /**
   * The heading pinned to the top edge: whichever day the topmost visible entry
   * belongs to.
   *
   * The one below it pushes it out of the way as it arrives, which is what
   * keeps two headings from ever being legible at once — and is why the in-flow
   * copy of the pinned day is not drawn at all (see `Day`, below).
   */
  const pinned = createMemo(() => {
    const list = entries();
    if (list.length === 0) return null;

    const at = entryAt(offsets(), scrollTop());
    for (let i = at; i >= 0; i -= 1) {
      const entry = list[i];
      if (entry?.kind === "heading") return entry;
    }
    return null;
  });

  /** How far the next heading has shoved the pinned one off the top edge. */
  const push = createMemo(() => {
    const list = entries();
    const table = offsets();

    for (let i = entryAt(table, scrollTop()) + 1; i < list.length; i += 1) {
      if (list[i]?.kind !== "heading") continue;
      const gap = table[i]! - scrollTop() - HEADING_HEIGHT;
      return gap < 0 ? gap : 0;
    }
    return 0;
  });

  /*
   * Which account a row belongs to, and only where that is a question. Inside
   * one account every row would carry the same letter, which is a column of
   * furniture saying nothing — so the chip is shown for the views that really
   * do mix accounts, and the subject starts at the pane edge everywhere else.
   */
  const accountRows = createMemo(() => accountKeys(props.store.accounts() ?? []));
  const showsAccounts = () =>
    props.store.currentAccount() === ALL_ACCOUNTS && accountRows().length > 2;

  const visible = createMemo(() => entries().slice(range().start, range().end));

  /*
   * Bringing the cursor back into view is the answer to the cursor having
   * moved, and to nothing else. While this also tracked `items()`, every
   * refetch ran it again — so a reader who scrolled the list with `C-e` had
   * their scrolling undone about half a second later by the autorefresh poll,
   * with the cursor still on the row it had always been on. Nothing on screen
   * connects that to a fetch; the list simply refuses to stay where it is put,
   * and at a desktop height with a short fixture it does not happen at all.
   */
  createEffect(
    on(
      () => props.store.selected(),
      (index) => {
        // `on` runs its callback untracked, so reading the list here does not
        // put the dependency back.
        const element = scroller();
        if (!element || items().length === 0) return;

        const top = topOf(index);
        const bottom = top + rowHeight();

        // A row brought to the very top would sit *under* the pinned heading,
        // which covers that band — so the top edge, for this purpose, is one
        // heading lower down. Clamped, because the first row of the list has
        // nothing above it to make room for.
        if (top - HEADING_HEIGHT < element.scrollTop) {
          element.scrollTop = Math.max(0, top - HEADING_HEIGHT);
        } else if (bottom > element.scrollTop + element.clientHeight) {
          element.scrollTop = bottom - element.clientHeight;
        }
      },
    ),
  );

  const focused = () => props.store.pane() === "list";

  return (
    <section
      class="pane relative h-full border-r border-rule"
      classList={{ "pane-focused": focused() }}
      style={{
        // Until the probe has been measured the token's own value stands, so
        // the first paint is a sensible column rather than a collapsed one.
        ...(dateWidth() > 0 ? { "--date-column": `${dateWidth()}px` } : {}),
      }}
      /* On capture, so a row opening a thread has the last word. */
      oncapture:click={() => props.store.setPane("list")}
    >
      {/*
        The ruler for the date track: one hidden copy of a row's date cell,
        carrying the widest date on the page. `visibility: hidden` rather than
        `display: none`, because a box that is not laid out has no width to
        read.
      */}
      <div
        ref={setProbe}
        aria-hidden="true"
        class="pointer-events-none invisible absolute top-0 left-0"
      >
        <DateCell when={widestDate()} attachment={anyAttachment()} />
      </div>

      <header class="list-header-grid shrink-0 border-b border-rule bg-paper-2 px-3 py-2 text-xs uppercase tracking-wide text-ink-3">
        <span class="truncate-cell mono">{props.store.query()}</span>
        <span class="mono text-right">
          {items().length}/{props.store.threads()?.total ?? 0}
        </span>
      </header>

      <Outbox store={props.store} />

      {/*
        The wrapper exists so the pinned heading has the scroller's own top edge
        to sit on, rather than a measured distance from the pane's — the strip
        above it comes and goes with the outbox, and a number would have to be
        re-measured every time it did.
      */}
      <div class="relative flex min-h-0 flex-1 flex-col">
      {/*
        The heading for whatever is at the top edge, drawn over the scroller
        rather than inside it — a `position: sticky` child cannot be had here,
        because the rendered slab is `transform`ed and a transform makes the
        containing block for everything inside it.

        It is pushed out by the next day arriving, so two headings are never
        both readable, and the in-flow copy of the day it names is not drawn at
        all — see `Day`.
      */}
      <Show when={pinned()}>
        {(day) => (
          <div
            class="pointer-events-none absolute top-0 right-0 left-0 z-10 overflow-hidden"
            style={{ height: `${HEADING_HEIGHT}px` }}
            aria-hidden="true"
          >
            <div style={{ transform: `translateY(${push()}px)` }}>
              <Heading label={day().label} />
            </div>
          </div>
        )}
      </Show>

      <div
        ref={attach}
        class="scroll-y flex-1"
        // Room for the compose button to sit over, so the last thread in the
        // list is never the one hidden under it.
        classList={{ "max-md:pb-20": true }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        /* Named for the same reason as the thread's: all three panes carry
           `scroll-y`, and a test about a chord has to say which one moved. */
        data-list-scroll
      >
        <Show
          when={items().length > 0}
          fallback={
            <div class="flex h-full items-center justify-center p-6 text-center">
              <Show
                when={!settling()}
                fallback={<span class="text-ink-3">loading…</span>}
              >
                {/*
                  A refused device is not an unreachable server: this one
                  answered, and said who it will not talk to. Reporting it as
                  "cannot reach" sends the reader to their network rather than
                  to the token that fixes it.
                */}
                <Show
                  when={!props.store.needsToken()}
                  fallback={
                    <div class="max-w-sm">
                      <p class="mb-2 text-blocking">this device is not authorised</p>
                      <p class="mb-3 text-xs text-ink-3">
                        Issue a token on the server with{" "}
                        <code>ecr token new &lt;name&gt;</code>.
                      </p>
                      <button
                        type="button"
                        class="touch-target rounded border border-rule px-3 py-1.5 text-obligation hover:bg-neutral-bg"
                        onClick={() => props.store.setAskingToken(true)}
                      >
                        enter a token
                      </button>
                    </div>
                  }
                >
                  <Show
                    when={props.store.lastError()}
                    fallback={<span class="text-ink-3">no matching threads</span>}
                  >
                    {(error) => (
                      <div class="max-w-sm">
                        {/*
                          The public health route is what tells these apart, and
                          they have nothing in common but an empty pane. Nothing
                          answered: the address is wrong, or no server is running
                          there, and the fix is in the address field. Something
                          answered and then this request failed: the address is
                          right and the server has an opinion worth repeating,
                          which sending the reader to their network would bury.
                        */}
                        <Show
                          when={!props.store.reachable()}
                          fallback={
                            <>
                              <p class="mb-2 text-blocking">the server could not answer</p>
                              <p class="mb-3 text-xs break-words text-ink-3">{error()}</p>
                              <button
                                type="button"
                                class="touch-target rounded border border-rule px-3 py-1.5 text-obligation hover:bg-neutral-bg"
                                onClick={() => props.store.retryServer()}
                              >
                                retry
                              </button>
                            </>
                          }
                        >
                          <p class="mb-2 text-blocking">cannot reach the server</p>
                          {/*
                            Above the HTTP error, and only when the browser is
                            certain there is no network. "Failed to fetch"
                            beside a perfectly good address sends a reader to
                            their server settings for a problem that is their
                            train going into a tunnel.
                          */}
                          <Show when={isOffline()}>
                            <p class="mb-2 text-xs text-ink-2">
                              this device has no network connection
                            </p>
                          </Show>
                          <p class="mb-3 text-xs break-words text-ink-3">{error()}</p>
                          <p class="mono mb-3 text-xs break-words text-ink-3">
                            {props.store.connection().baseUrl || "no server url configured"}
                          </p>
                          <div class="flex flex-wrap justify-center gap-2">
                            <button
                              type="button"
                              class="touch-target rounded border border-rule px-3 py-1.5 text-obligation hover:bg-neutral-bg"
                              onClick={() => props.store.retryServer()}
                            >
                              retry
                            </button>
                            <button
                              type="button"
                              class="touch-target rounded border border-rule px-3 py-1.5 text-obligation hover:bg-neutral-bg"
                              onClick={() => props.store.setAskingServer(true)}
                            >
                              change address
                            </button>
                          </div>
                        </Show>
                      </div>
                    )}
                  </Show>
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
                  <Show
                    when={entry.kind === "thread" ? entry : undefined}
                    fallback={
                      // The day the pinned heading is already showing is not
                      // drawn again underneath it — but it still takes up its
                      // box. `invisible` rather than not rendering: the offset
                      // table says where every entry below this one starts, and
                      // a heading that vanishes from the flow moves all of them
                      // up by its own height while the table still says
                      // otherwise.
                      <Heading
                        label={entry.kind === "heading" ? entry.label : ""}
                        hidden={entry.kind === "heading" && entry.key === pinned()?.key}
                      />
                    }
                  >
                    {(row) => (
                      <Row
                        thread={row().thread}
                        index={row().index}
                        store={props.store}
                        span={row().span}
                        account={() =>
                          showsAccounts()
                            ? accountOf(row().thread.tags, accountRows())
                            : undefined
                        }
                      />
                    )}
                  </Show>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
      </div>

      {/*
        Compose is `c` on a desktop and the sidebar's button on any screen, but
        on a phone the sidebar is a place you have to travel to — and writing a
        message is the one thing you should never have to travel for.
      */}
      <button
        type="button"
        class="absolute right-4 bottom-4 flex size-14 items-center justify-center rounded-icon bg-obligation text-xl text-paper shadow-lg md:hidden"
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

/**
 * A heading, in the flow or pinned to the top edge — the same component
 * either way, because they are the same height and the pinned one replaces the
 * one sliding under it exactly.
 *
 * The height is written on the box rather than left to the line: it is one of
 * the numbers in the offset table, and a heading that measured a pixel
 * differently from what the table says would put every row below it a pixel
 * out, compounding down the list.
 */
function Heading(props: { label: string; hidden?: boolean }) {
  return (
    <div
      data-heading
      class="flex items-center bg-paper px-3 text-[11px] font-semibold tracking-widest text-ink-3 uppercase"
      classList={{ invisible: props.hidden }}
      style={{ height: `${HEADING_HEIGHT}px` }}
    >
      {props.label}
    </div>
  );
}

function Row(props: {
  thread: ThreadSummary;
  index: number;
  store: AppStore;
  /** The granularity of the heading above, so the date says only the rest. */
  span?: Span;
  /** The account this row belongs to, where more than one is on screen. */
  account: () => AccountKey | undefined;
}) {
  const selected = () => props.store.selected() === props.index;
  const unread = () => props.thread.tags.includes("unread");
  const flagged = () => props.thread.tags.includes("flagged");
  const attachment = () => props.thread.tags.includes("attachment");

  const badges = () => badgesFor(props.store.marks[props.thread.id]);

  const picked = () => props.store.isSelected(props.index);
  // `picked` is the whole selection — Space-picked rows *and* the v range.
  // The tape belongs to what Space actually marked, so a range being drawn
  // reads as a range (the background) rather than as a column of marks.
  const isPicked = () => props.store.picked().includes(props.thread.id);

  const when = () => dateOf(props.thread, props.store, props.span);

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
      class="row-grid row-card touch-target relative mx-1.5 cursor-pointer rounded-card py-1 pl-2 pr-2.5"
      style={{
        height: `${cardHeight()}px`,
        "margin-bottom": `${ROW_GAP}px`,
        transform: offset() === 0 ? undefined : `translateX(${offset()}px)`,
        // Sliding sideways must not also drag the row out of the list.
        "touch-action": "pan-y",
      }}
      classList={{
        // The cursor is the ring and the selection is the fill, so a row that
        // is both still reads as both. `neutral_bg` is the palette's hover, so
        // a selection painted in it was invisible next to an unselected row —
        // `proved` is the role that means selected, in every theme.
        "row-card-selected": selected(),
        "row-card-picked": picked() && !selected(),
        "bg-proved-bg text-ink": picked(),
        "bg-obligation-bg text-ink": selected() && !picked(),
        // The card's own surface, so the rule and the shadow have something to
        // sit on. It is a utility rather than a rule in `.row-card` because the
        // two above have to be able to win — see components.css.
        "bg-card": !selected() && !picked(),
        "hover:bg-neutral-bg": !selected() && !picked(),
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
          "tape-selected": badges() === "" && isPicked(),
          "tape-unread": badges() === "" && !picked() && unread(),
          "tape-flagged": badges() === "" && !picked() && !unread() && flagged(),
        }}
        title={
          badges() ||
          (isPicked()
            ? "selected"
            : !picked() && unread()
              ? "unread"
              : !picked() && !unread() && flagged()
                ? "flagged"
                : "")
        }
      />

      <div class="flex min-w-0 items-center gap-2">
        <Show when={props.store.selectionMode()}>
          <span
            aria-hidden="true"
            class="flex size-5 shrink-0 items-center justify-center rounded-chip border text-xs"
            classList={{
              "border-obligation bg-obligation text-paper": isPicked(),
              "border-rule text-transparent": !isPicked(),
            }}
          >
            ✓
          </span>
        </Show>

        {/*
          What is staged, so it can be read before x writes it. Beside the tape
          rather than over it: on a one-line row there is no second line for a
          badge to sit under, and an absolutely positioned one landed on the
          subject.
        */}
        <Show when={badges()}>
          {/*
            Named, because it is no longer the only monospaced span on a row —
            the thread count moved in beside it when the row became one line,
            and `verify-marks` reading "the first `span.mono`" then read `(2)`
            and reported a queue that would not clear.
          */}
          <span data-badge class="mono shrink-0 text-[10px] text-blocking">
            {badges()}
          </span>
        </Show>

        {/*
          Which account this arrived in, as the letter that switches to it —
          `accountKeys` hands out both, so the badge is never a second alphabet
          to learn. Deliberately monochrome: the palette's three accents mean
          proved, owed and blocking, and a colour per account would make every
          row look like a status it does not have.
        */}
        <Show when={props.account()}>
          {(account) => (
            <span class="account-chip shrink-0" title={account().label} aria-hidden="true">
              {account().key}
            </span>
          )}
        </Show>

        {/*
          The subject, and nothing else. Every message in this mailbox is
          addressed to the reader, so the sender was the one line of a row that
          could be dropped without losing what the row is for — and the From
          display name is not even reliably a person: GitHub and every other
          notification sender puts the *actor's* name there, which on a CI
          mailbox is the reader's own, on every row.
        */}
        <span
          class="truncate-cell"
          classList={{
            "text-ink font-semibold": unread(),
            "text-ink-2": !unread(),
          }}
        >
          {props.thread.subject || "(no subject)"}
        </span>

        {/*
          How many messages are under it. Beside the subject rather than under
          the date: the date column is sized to the pixel for a date that must
          never wrap, and this used to have a line of its own to sit on.
        */}
        <Show when={props.thread.total > 1}>
          <span class="mono shrink-0 text-xs text-proved">({props.thread.total})</span>
        </Show>
      </div>

      <DateCell
        when={when()}
        attachment={attachment()}
        relative={props.thread.date_relative}
      />
    </div>
  );
}

/**
 * The right-hand column of a row: the attachment marker, then the date.
 *
 * A component rather than markup inside `Row` because the pane renders a
 * *second*, hidden one to measure the track from — see `--date-column` above.
 * Anything the two could differ by is a column sized for something no row
 * prints, so there is only one of them.
 *
 * The date never wraps. The column is sized for it, and a marker beside it on a
 * phone was once enough to push `01 Apr 14:30` onto two lines, which makes one
 * row taller than the height the virtual scroller is built on.
 */
function DateCell(props: {
  when: string;
  attachment: boolean;
  relative?: string;
}) {
  return (
    <div
      data-date
      class="mono flex shrink-0 items-center justify-end gap-1.5 whitespace-nowrap text-right text-xs text-ink-3"
    >
      {/* notmuch tags these itself, so it costs no extra read. */}
      <Show when={props.attachment}>
        <span
          class="shrink-0"
          aria-label="has an attachment"
          title="has an attachment"
        >
          ◆
        </span>
      </Show>
      <span class="shrink-0" title={props.relative}>
        {props.when}
      </span>
    </div>
  );
}
