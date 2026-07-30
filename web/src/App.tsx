import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { Keymap, type Action } from "./keymap/engine";
import { createAppStore } from "./state/store";
import { Sidebar } from "./ui/Sidebar";
import { ThreadList } from "./ui/ThreadList";
import { ReadingPane } from "./ui/ReadingPane";
import { Palette } from "./ui/Palette";
import { Compose, emptyDraft } from "./ui/Compose";
import { ConnectionSetup, Help, StatusBar, TopBar } from "./ui/Chrome";
import type { Draft } from "./api/types";

/** A key belongs to a text field whenever one of these has focus. */
function isEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

export function App() {
  const store = createAppStore();
  const keymap = new Keymap();

  const [showHelp, setShowHelp] = createSignal(false);
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [mobilePane, setMobilePane] = createSignal<"list" | "reading">("list");

  const configured = () => store.connection().baseUrl !== "";

  onMount(() => {
    const unsubscribe = store.subscribe();
    document.addEventListener("keydown", onKeyDown);

    onCleanup(() => {
      unsubscribe();
      document.removeEventListener("keydown", onKeyDown);
    });
  });

  function onKeyDown(event: KeyboardEvent) {
    if (draft()) return;

    const outcome = keymap.handle(
      { key: event.key, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey },
      store.mode(),
      isEditing(event.target),
    );

    store.setPendingKeys(keymap.sequence);

    if (outcome.type === "cancelled") {
      event.preventDefault();
      if (showHelp()) setShowHelp(false);
      store.setMode("normal");
      store.setPalette("");
      if (isEditing(event.target)) (event.target as HTMLElement).blur();
      return;
    }

    if (outcome.type === "action") {
      event.preventDefault();
      void dispatch(outcome.action);
    }
  }

  async function dispatch(action: Action) {
    switch (action.kind) {
      case "next":
        store.move(1);
        break;
      case "prev":
        store.move(-1);
        break;
      case "first":
        store.setSelected(0);
        break;
      case "last":
        store.setSelected(Math.max(store.items().length - 1, 0));
        break;
      case "open": {
        const thread = store.current();
        if (thread) {
          store.setOpenThread(thread.id);
          setMobilePane("reading");
        }
        break;
      }
      case "back":
        setMobilePane("list");
        store.setOpenThread(null);
        break;
      case "archive":
        store.mark("archive");
        break;
      case "delete":
        store.mark("delete");
        break;
      case "toggleRead": {
        const thread = store.current();
        if (thread) {
          const unread = thread.tags.includes("unread");
          await store.applyNow(unread ? [] : ["unread"], unread ? ["unread"] : []);
        }
        break;
      }
      case "toggleFlag": {
        const thread = store.current();
        if (thread) {
          const flagged = thread.tags.includes("flagged");
          await store.applyNow(flagged ? [] : ["flagged"], flagged ? ["flagged"] : []);
        }
        break;
      }
      case "executeMarks":
        await store.executeMarks();
        break;
      case "clearMarks":
        store.clearMarks();
        break;
      case "sync":
        await store.sync();
        break;
      case "compose":
        setDraft(emptyDraft());
        break;
      case "reply":
      case "forward": {
        const thread = store.thread();
        const message = thread?.messages[thread.messages.length - 1];
        if (!message) {
          store.setStatus("open a thread first");
          break;
        }
        setDraft(
          action.kind === "forward"
            ? {
                ...emptyDraft(),
                subject: prefixed(message.subject, "Fwd:"),
                body: `\n\n---------- Forwarded message ----------\nFrom: ${message.from
                  .map((a) => a.email)
                  .join(", ")}\nSubject: ${message.subject}\n\n`,
              }
            : {
                ...emptyDraft(),
                to: (message.reply_to.length ? message.reply_to : message.from).map(
                  (a) => a.email,
                ),
                cc: action.all ? message.cc.map((a) => a.email) : [],
                subject: prefixed(message.subject, "Re:"),
                in_reply_to: message.id,
                references: [...message.references, message.id],
                body: `\n\nOn ${message.date}, ${message.from[0]?.email ?? "someone"} wrote:\n`,
              },
        );
        break;
      }
      case "enterCommand":
        store.setMode("command");
        break;
      case "enterSearch":
        store.setMode("search");
        store.setPalette(store.query());
        break;
      case "help":
        setShowHelp(true);
        break;
      case "paneLeft":
        setMobilePane("list");
        break;
      case "paneRight":
        setMobilePane("reading");
        break;
      default:
        store.setStatus(`${action.kind} is not wired up yet`);
    }
  }

  return (
    <Show when={configured()} fallback={<ConnectionSetup store={store} />}>
      <div class="relative flex h-full flex-col">
        <TopBar store={store} onSync={() => void store.sync()} />

        <main class="grid min-h-0 flex-1 md:grid-cols-[14rem_minmax(0,1.1fr)_minmax(0,1.4fr)]">
          <div class="hidden md:block">
            <Sidebar store={store} onCompose={() => setDraft(emptyDraft())} />
          </div>

          <div
            class="min-h-0"
            classList={{ hidden: mobilePane() !== "list", "md:block": true }}
          >
            <ThreadList store={store} />
          </div>

          <div
            class="min-h-0"
            classList={{ hidden: mobilePane() !== "reading", "md:block": true }}
          >
            <ReadingPane store={store} />
          </div>
        </main>

        <StatusBar store={store} />
        <Palette store={store} />

        <Show when={showHelp()}>
          <Help store={store} bindings={keymap.describe()} onClose={() => setShowHelp(false)} />
        </Show>

        <Show when={draft()}>
          {(current) => (
            <Compose store={store} draft={current()} onClose={() => setDraft(null)} />
          )}
        </Show>
      </div>
    </Show>
  );
}

function prefixed(subject: string, prefix: string): string {
  const trimmed = subject.trim();
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase())
    ? trimmed
    : `${prefix} ${trimmed}`;
}
