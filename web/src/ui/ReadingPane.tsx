import { For, Show, createEffect, createResource, createSignal, onCleanup } from "solid-js";
import type { Message } from "../api/types";
import type { AppStore } from "../state/store";
import { absolutizePartUrls } from "./body-urls";
import { toggleLabel } from "../state/format";
import { linkify } from "./linkify";
import { openExternal } from "../api/platform";
import { attachViewCursor, type ViewTarget } from "./view-mode";

export function ReadingPane(props: { store: AppStore; onBack?: () => void }) {
  let scroller: HTMLDivElement | undefined;
  const thread = () => props.store.thread();

  // Keep the keyboard-selected message in view when J/K walk the thread.
  createEffect(() => {
    const index = props.store.messageIndex();
    if (!scroller) return;
    scroller
      .querySelector<HTMLElement>(`[data-message="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });

  return (
    <>
      <Show
        when={thread()}
        fallback={
          <div class="flex flex-1 items-center justify-center text-ink-3">
            select a thread to read
          </div>
        }
      >
        {(loaded) => (
          <>
            <header class="flex shrink-0 items-start gap-3 border-b border-rule px-4 py-3">
              {/* Touch has no h/l, so the way back has to be visible. */}
              <button
                type="button"
                class="touch-target -ml-1 shrink-0 rounded px-2 py-1 text-ink-3 hover:bg-neutral-bg md:hidden"
                aria-label="Back to the list"
                onClick={() => props.onBack?.()}
              >
                ‹ list
              </button>

              <div class="min-w-0 flex-1">
              <h1 class="text-base text-ink">{loaded().subject || "(no subject)"}</h1>
              <div class="text-xs text-ink-3">
                {loaded().messages.length} message{loaded().messages.length === 1 ? "" : "s"}
                {/*
                  Keys only where there are keys. On a phone these named three
                  things you cannot do, right under the subject, and the actions
                  they stand for are on the bar at the bottom instead.
                */}
                <span class="hidden md:inline">
                  {" · "}
                  <kbd>J</kbd>/<kbd>K</kbd> message · <kbd>za</kbd> fold · <kbd>r</kbd> reply
                </span>
              </div>
              </div>
            </header>

            <div
              ref={(el) => {
                scroller = el;
                props.store.setDetailScroller(el);
              }}
              class="scroll-y flex-1"
            >
              <For each={loaded().messages}>
                {(message, index) => (
                  <MessageView
                    message={message}
                    index={index()}
                    store={props.store}
                    total={loaded().messages.length}
                    newest={index() === loaded().messages.length - 1}
                  />
                )}
              </For>
            </div>
          </>
        )}
      </Show>
    </>
  );
}

function MessageView(props: {
  message: Message;
  index: number;
  store: AppStore;
  total: number;
  newest: boolean;
}) {
  const open = () => props.store.messageOpen(props.message.id, props.newest);

  /** The message the conversation cursor is on, and so the one keys act upon. */
  const current = () => props.store.messageIndex() === props.index;

  // Not pane-scoped: C-j/C-k walk the conversation from anywhere, so the tint
  // has to be visible from anywhere too. A single-message thread needs none.
  const cursor = () => props.total > 1 && current();

  const wanted = () => props.store.messageFormat(props.message.id);

  const [body] = createResource(
    () =>
      open()
        ? ([props.message.id, props.store.allowRemote(), wanted() === "html"] as const)
        : null,
    async (key) => {
      if (!key) return null;
      const [id, remote, html] = key;
      return props.store.api.body(id, html, remote).catch(() => null);
    },
  );

  // Reading it is what marks it read: the body has to have loaded and stayed
  // on screen, not merely been scrolled past.
  createEffect(() => {
    if (open() && body()) {
      props.store.markReadWhenSeen(props.message.id, props.message.tags);
    } else {
      props.store.cancelMarkRead(props.message.id);
    }
  });

  onCleanup(() => props.store.cancelMarkRead(props.message.id));

  const attachments = () => props.message.parts.filter((p) => p.disposition === "attachment");

  /** The rendered body, whichever way it was rendered, for the reading cursor. */
  const [target, setTarget] = createSignal<ViewTarget | null>(null);

  createEffect(() => {
    if (!props.store.viewing() || !current() || !open()) return;

    const rendered = target();
    if (!rendered) return;

    const detach = attachViewCursor(rendered, {
      scroller: props.store.detailScroller(),
      onExit: () => props.store.setViewing(false),
      onStatus: (text) => props.store.setStatus(text),
    });
    onCleanup(detach);
  });

  return (
    <article
      data-message={props.index}
      class="border-b border-rule"
      classList={{ "bg-neutral-bg/40": cursor() }}
    >
      <button
        type="button"
        class="touch-target flex w-full items-baseline gap-3 px-4 py-3 text-left hover:bg-neutral-bg"
        onClick={() => {
          props.store.setMessageIndex(props.index);
          props.store.toggleCollapsed(props.message.id, props.newest);
        }}
      >
        <span class="shrink-0 text-ink-3">{open() ? "▾" : "▸"}</span>
        <span class="truncate-cell flex-1 text-ink">
          {props.message.from.map(sender).join(", ")}
        </span>
        <span class="shrink-0 text-xs text-ink-3">{props.message.date}</span>
      </button>

      <Show when={open()}>
        <div class="px-4 pb-4">
          <dl class="mb-3 grid grid-cols-[3rem_minmax(0,1fr)] gap-x-2 text-xs text-ink-3">
            <Recipients label="to" list={props.message.to} />
            <Recipients label="cc" list={props.message.cc} />
            <dt class="uppercase">id</dt>
            <dd class="mono truncate-cell" title={props.message.id}>
              {props.message.id}
            </dd>
          </dl>

          <Show when={attachments().length > 0}>
            <div class="mb-3 flex flex-wrap gap-2">
              <For each={attachments()}>
                {(part) => (
                  <a
                    class="touch-target rounded border border-rule bg-card px-2 py-1 text-xs text-proved hover:bg-neutral-bg"
                    href={props.store.api.partUrl(props.message.id, part.id)}
                    download={part.filename ?? undefined}
                  >
                    ⇩ {part.filename ?? `part-${part.id}`} ({formatSize(part.size)})
                  </a>
                )}
              </For>
            </div>
          </Show>

          <Show when={body()} fallback={<div class="text-ink-3">loading…</div>}>
            {(loaded) => (
              <>
                <Show
                  when={loaded().remote_resources_blocked > 0 && !props.store.allowRemote()}
                >
                  <div class="mb-2 flex items-center gap-2 rounded border border-rule bg-card px-2 py-1 text-xs">
                    <span class="text-ink-3">
                      {loaded().remote_resources_blocked} remote image
                      {loaded().remote_resources_blocked === 1 ? "" : "s"} blocked
                    </span>
                    <button
                      type="button"
                      class="text-obligation hover:underline"
                      onClick={() => props.store.setAllowRemote(true)}
                    >
                      load (i)
                    </button>
                  </div>
                </Show>

                {/*
                  Plain text needs no iframe: there is nothing to sandbox and
                  nothing to measure, so it paints immediately instead of
                  waiting on a document load and a resize.
                */}
                {/*
                  Only offered when the message actually has an HTML part —
                  otherwise the button would promise a view that does not exist.
                */}
                <Show when={loaded().has_html}>
                  <div class="mb-2 flex items-center gap-3 text-xs text-ink-3">
                    <button
                      type="button"
                      class="rounded border border-rule px-2 py-0.5 hover:bg-neutral-bg"
                      onClick={() => props.store.toggleFormat(props.message.id)}
                      title="Switch between html and plain text (t)"
                    >
                      {toggleLabel(wanted())}
                    </button>
                  </div>
                </Show>

                <Show
                  when={loaded().format === "html"}
                  fallback={
                    <pre
                      ref={(el) => setTarget({ root: el, frame: null })}
                      class="mono max-w-full overflow-x-auto rounded border border-rule-soft bg-card p-3 text-[13px] leading-relaxed whitespace-pre-wrap text-ink"
                      // Bare URLs become links so Enter opens them here too.
                      innerHTML={linkify(loaded().content)}
                      // These are in the app's own document, so `target=_blank`
                      // is the whole plan — and a Tauri webview has no second
                      // window to honour it with, on Android least of all.
                      onClick={(event) => {
                        const target = event.target as Element | null;
                        const anchor = target?.closest?.("a") ?? null;
                        const href = anchor?.getAttribute("href");
                        if (!href) return;
                        event.preventDefault();
                        void openExternal(href);
                      }}
                    />
                  }
                >
                  <BodyFrame
                    html={absolutizePartUrls(
                      loaded().content,
                      props.store.api.baseUrl,
                      props.store.connection().token,
                    )}
                    onReady={(doc, frame) => setTarget({ root: doc.body, frame })}
                  />
                </Show>
              </>
            )}
          </Show>
        </div>
      </Show>
    </article>
  );
}

/** A name alone hides which address actually sent it. */
function sender(address: { name: string | null; email: string }): string {
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

function Recipients(props: { label: string; list: { name: string | null; email: string }[] }) {
  return (
    <Show when={props.list.length > 0}>
      <dt class="uppercase">{props.label}</dt>
      <dd class="truncate-cell">{props.list.map((a) => a.email).join(", ")}</dd>
    </Show>
  );
}

/**
 * Message HTML is already sanitized server-side; the sandbox is the second
 * layer. `allow-scripts` is the flag that matters and is never granted, so
 * nothing in a message can execute. `allow-same-origin` *is* granted, because
 * without it the parent cannot measure the document and every message rendered
 * at a fixed height, truncated. Same-origin access is inert without scripts.
 *
 * The canvas is white on purpose. Real mail is authored for a light
 * background, and forcing a dark one produced dark-on-dark text in a large
 * share of messages.
 */
function BodyFrame(props: {
  html: string;
  onReady?: (doc: Document, frame: HTMLIFrameElement) => void;
}) {
  let frame: HTMLIFrameElement | undefined;

  const document = () => `<!doctype html>
<html><head><meta charset="utf-8">
<!--
  "only light" is the hard opt-out. Plain "light" still leaves
  prefers-color-scheme reporting dark, and engines with forced-dark
  (WebKitGTK under a dark GTK theme, Chrome's auto dark) then darken the
  canvas while leaving explicitly dark text untouched — which is exactly
  the dark-on-dark, half-invisible message.
-->
<meta name="color-scheme" content="only light">
<style>
  :root, html, body { color-scheme: only light; }
  body {
    margin: 0; padding: 12px 14px;
    background: #ffffff; color: #17242b;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 13px; line-height: 1.55;
    word-wrap: break-word; overflow-wrap: anywhere;
  }
  /*
   * Last-resort contrast guard. A message that sets a dark background on a
   * container but leaves its text to inherit ends up invisible on the white
   * canvas; the reverse happens when an engine darkens the canvas. Anything
   * that declares a background dark enough to matter gets a light foreground
   * so the text is legible either way.
   */
  [bgcolor="#000000"], [bgcolor="#000"], [bgcolor="#111111"], [bgcolor="#1a1a1a"],
  [bgcolor="#222222"], [bgcolor="#333333"] {
    color: #f4f7f8;
  }

  /* Senders assume a viewport far wider than this pane. */
  table { max-width: 100% !important; width: auto !important; }
  td, th { word-break: break-word; }
  * { max-width: 100%; }
  a { color: #4636a8; }
  blockquote {
    margin: 0 0 0 .5rem; padding-left: .75rem;
    border-left: 2px solid #c2d0d7; color: #0e6b5e;
  }
  img { max-width: 100%; height: auto; }
  pre { overflow-x: auto; }
  table { max-width: 100%; }
</style></head>
<body>${props.html}</body></html>`;

  /**
   * Resizing once on load leaves most messages truncated: images, webfonts and
   * table layout all settle afterwards. Watch the content instead, and stop
   * once it has been stable for a moment.
   */
  const fit = () => {
    const doc = frame?.contentDocument;
    if (!frame || !doc?.body) return;

    props.onReady?.(doc, frame);

    /*
     * A tapped link had nowhere to go. The frame is sandboxed without
     * `allow-top-navigation`, so following one either replaced the message with
     * the page or did nothing at all — and in a Tauri webview, nothing at all.
     * The parent already reaches into `contentDocument` to measure the
     * document, and reaches in here to hand the URL to the system browser.
     * Still no script runs inside the frame.
     */
    const follow = (event: MouseEvent) => {
      // `instanceof Element` is a lie across realms: this node belongs to the
      // frame's window, so it is an instance of *its* Element and not of ours,
      // and the guard threw every click away. Ask the node what it can do
      // instead of which constructor it came from.
      const target = event.target as Element | null;
      if (typeof target?.closest !== "function") return;

      const anchor = target.closest("a");
      const href = anchor?.getAttribute("href");
      if (!href) return;

      event.preventDefault();
      void openExternal(href);
    };

    doc.addEventListener("click", follow);
    onCleanup(() => doc.removeEventListener("click", follow));

    const measure = () => {
      const height = Math.max(
        doc.body.scrollHeight,
        doc.documentElement?.scrollHeight ?? 0,
      );
      if (height > 0) frame.style.height = `${height + 24}px`;
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(doc.body);
    doc.defaultView?.addEventListener("load", measure);

    // Late-arriving images reflow the document well after `load`.
    const timers = [50, 150, 400, 1000, 2500].map((delay) =>
      window.setTimeout(measure, delay),
    );

    onCleanup(() => {
      observer.disconnect();
      timers.forEach(window.clearTimeout);
    });
  };

  return (
    <iframe
      ref={frame}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcdoc={document()}
      class="w-full rounded border border-rule-soft bg-white"
      style={{ height: "6rem" }}
      onLoad={fit}
      title="message body"
    />
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}
