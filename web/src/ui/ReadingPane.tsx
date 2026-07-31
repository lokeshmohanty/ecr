import { For, Show, createEffect, createResource, onCleanup } from "solid-js";
import type { Message } from "../api/types";
import type { AppStore } from "../state/store";
import { absolutizePartUrls } from "./body-urls";

export function ReadingPane(props: { store: AppStore }) {
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
          <div class="flex flex-1 items-center justify-center text-text-dim">
            select a thread to read
          </div>
        }
      >
        {(loaded) => (
          <>
            <header class="shrink-0 border-b border-border px-4 py-3">
              <h1 class="text-base text-text-strong">{loaded().subject || "(no subject)"}</h1>
              <div class="text-xs text-text-dim">
                {loaded().messages.length} message{loaded().messages.length === 1 ? "" : "s"}
                {" · "}
                <kbd>J</kbd>/<kbd>K</kbd> message · <kbd>za</kbd> fold · <kbd>r</kbd> reply
              </div>
            </header>

            <div ref={scroller} class="scroll-y flex-1">
              <For each={loaded().messages}>
                {(message, index) => (
                  <MessageView
                    message={message}
                    index={index()}
                    store={props.store}
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
  newest: boolean;
}) {
  const expandByDefault = () =>
    props.newest ? props.store.settings().preferences.expandNewest : false;

  const open = () => {
    const explicit = props.store.collapsed[props.message.id];
    return explicit === undefined ? expandByDefault() : !explicit;
  };

  const cursor = () =>
    props.store.pane() === "detail" && props.store.messageIndex() === props.index;

  const [body] = createResource(
    () =>
      open()
        ? ([props.message.id, props.store.allowRemote(), props.store.settings().preferences.preferHtml] as const)
        : null,
    async (key) => {
      if (!key) return null;
      const [id, remote, html] = key;
      return props.store.api.body(id, html, remote).catch(() => null);
    },
  );

  const attachments = () => props.message.parts.filter((p) => p.disposition === "attachment");

  return (
    <article
      data-message={props.index}
      class="border-b border-border"
      classList={{ "bg-bg-hover/40": cursor() }}
    >
      <button
        type="button"
        class="touch-target flex w-full items-baseline gap-3 px-4 py-3 text-left hover:bg-bg-hover"
        onClick={() => {
          props.store.setMessageIndex(props.index);
          props.store.toggleCollapsed(props.message.id);
        }}
      >
        <span class="shrink-0 text-text-dim">{open() ? "▾" : "▸"}</span>
        <span class="truncate-cell flex-1 text-text-strong">
          {props.message.from.map((a) => a.name ?? a.email).join(", ")}
        </span>
        <span class="shrink-0 text-xs text-text-dim">{props.message.date}</span>
      </button>

      <Show when={open()}>
        <div class="px-4 pb-4">
          <dl class="mb-3 grid grid-cols-[3rem_minmax(0,1fr)] gap-x-2 text-xs text-text-dim">
            <Recipients label="to" list={props.message.to} />
            <Recipients label="cc" list={props.message.cc} />
          </dl>

          <Show when={attachments().length > 0}>
            <div class="mb-3 flex flex-wrap gap-2">
              <For each={attachments()}>
                {(part) => (
                  <a
                    class="touch-target rounded border border-border bg-bg-raised px-2 py-1 text-xs text-accent-dim hover:bg-bg-hover"
                    href={props.store.api.partUrl(props.message.id, part.id)}
                    download={part.filename ?? undefined}
                  >
                    ⇩ {part.filename ?? `part-${part.id}`} ({formatSize(part.size)})
                  </a>
                )}
              </For>
            </div>
          </Show>

          <Show when={body()} fallback={<div class="text-text-dim">loading…</div>}>
            {(loaded) => (
              <>
                <Show
                  when={loaded().remote_resources_blocked > 0 && !props.store.allowRemote()}
                >
                  <div class="mb-2 flex items-center gap-2 rounded border border-border bg-bg-raised px-2 py-1 text-xs">
                    <span class="text-text-dim">
                      {loaded().remote_resources_blocked} remote image
                      {loaded().remote_resources_blocked === 1 ? "" : "s"} blocked
                    </span>
                    <button
                      type="button"
                      class="text-accent hover:underline"
                      onClick={() => props.store.setAllowRemote(true)}
                    >
                      load (i)
                    </button>
                  </div>
                </Show>

                <BodyFrame
                  html={absolutizePartUrls(
                    loaded().content,
                    props.store.api.baseUrl,
                    props.store.connection().token,
                  )}
                  plain={loaded().format === "text"}
                />
              </>
            )}
          </Show>
        </div>
      </Show>
    </article>
  );
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
function BodyFrame(props: { html: string; plain: boolean }) {
  let frame: HTMLIFrameElement | undefined;

  const document = () => `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; padding: 0;
    background: #ffffff; color: #1b2a5c;
    font-family: ${props.plain ? '"Cascadia Code", ui-monospace, monospace' : "system-ui, -apple-system, Segoe UI, sans-serif"};
    font-size: 13px; line-height: 1.6;
    word-wrap: break-word; overflow-wrap: anywhere;
    ${props.plain ? "white-space: pre-wrap;" : ""}
  }
  a { color: #2e7de9; }
  blockquote {
    margin: 0 0 0 .5rem; padding-left: .75rem;
    border-left: 2px solid #a8aecb; color: #587539;
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
      class="w-full rounded border border-border-soft bg-white"
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
