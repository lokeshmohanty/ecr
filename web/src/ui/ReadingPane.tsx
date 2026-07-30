import { For, Show, createResource, createSignal } from "solid-js";
import type { Message } from "../api/types";
import type { AppStore } from "../state/store";
import { absolutizePartUrls } from "./body-urls";

export function ReadingPane(props: { store: AppStore }) {
  const thread = () => props.store.thread();

  return (
    <section class="flex h-full min-w-0 flex-col">
      <Show
        when={thread()}
        fallback={
          <div class="flex h-full items-center justify-center text-text-dim">
            select a thread to read
          </div>
        }
      >
        {(loaded) => (
          <>
            <header class="border-b border-border px-4 py-3">
              <h1 class="truncate-cell text-base text-text-primary">
                {loaded().subject || "(no subject)"}
              </h1>
              <div class="text-xs text-text-dim">
                {loaded().messages.length} message
                {loaded().messages.length === 1 ? "" : "s"}
              </div>
            </header>

            <div class="scroll-y flex-1">
              <For each={loaded().messages}>
                {(message, index) => (
                  <MessageView
                    message={message}
                    store={props.store}
                    expanded={index() === loaded().messages.length - 1}
                  />
                )}
              </For>
            </div>
          </>
        )}
      </Show>
    </section>
  );
}

function MessageView(props: { message: Message; store: AppStore; expanded: boolean }) {
  const [open, setOpen] = createSignal(props.expanded);

  const [body] = createResource(
    () => (open() ? ([props.message.id, props.store.allowRemote()] as const) : null),
    async (key) => {
      if (!key) return null;
      const [id, remote] = key;
      return props.store.api.body(id, true, remote).catch(() => null);
    },
  );

  const attachments = () =>
    props.message.parts.filter((p) => p.disposition === "attachment");

  return (
    <article class="border-b border-border">
      <button
        type="button"
        class="touch-target flex w-full items-baseline gap-3 px-4 py-3 text-left hover:bg-bg-hover"
        onClick={() => setOpen((v) => !v)}
      >
        <span class="text-text-dim">{open() ? "▾" : "▸"}</span>
        <span class="truncate-cell flex-1 text-text-secondary">
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
                    class="touch-target rounded border border-border bg-bg-tag px-2 py-1 text-xs text-accent-dim hover:bg-bg-hover"
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
                <Show when={loaded().remote_resources_blocked > 0 && !props.store.allowRemote()}>
                  <div class="mb-2 flex items-center gap-2 rounded border border-border bg-bg-tag px-2 py-1 text-xs">
                    <span class="text-text-dim">
                      {loaded().remote_resources_blocked} remote image
                      {loaded().remote_resources_blocked === 1 ? "" : "s"} blocked
                    </span>
                    <button
                      type="button"
                      class="text-accent hover:underline"
                      onClick={() => props.store.setAllowRemote(true)}
                    >
                      load
                    </button>
                  </div>
                </Show>

                <BodyFrame
                  html={absolutizePartUrls(
                    loaded().content,
                    props.store.api.baseUrl,
                    props.store.connection().token,
                  )}
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
 * layer. `allow-same-origin` is deliberately absent, so even if something got
 * through it has no access to the app's origin, storage or cookies.
 */
function BodyFrame(props: { html: string }) {
  let frame: HTMLIFrameElement | undefined;

  const document = () => `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 0;
    background: #1a1b26; color: #c0caf5;
    font-family: "Cascadia Code", ui-monospace, monospace;
    font-size: 13px; line-height: 1.6;
    word-wrap: break-word; overflow-wrap: anywhere;
  }
  a { color: #7aa2f7; }
  blockquote {
    margin: 0 0 0 .5rem; padding-left: .75rem;
    border-left: 2px solid #292e42; color: #9ece6a;
  }
  img { max-width: 100%; height: auto; }
  pre { overflow-x: auto; }
  table { max-width: 100%; }
</style></head>
<body>${props.html}</body></html>`;

  const resize = () => {
    if (!frame?.contentDocument?.body) return;
    frame.style.height = `${frame.contentDocument.body.scrollHeight + 16}px`;
  };

  return (
    <iframe
      ref={frame}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcdoc={document()}
      class="w-full border-0"
      style={{ height: "12rem" }}
      onLoad={resize}
      title="message body"
    />
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}
