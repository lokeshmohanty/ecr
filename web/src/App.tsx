import { Match, Show, Switch, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Keymap, type Action } from "./keymap/engine";
import { createAppStore } from "./state/store";
import { Sidebar } from "./ui/Sidebar";
import { ThreadList } from "./ui/ThreadList";
import { ReadingPane } from "./ui/ReadingPane";
import { Palette } from "./ui/Palette";
import { ComposePane, emptyDraft } from "./ui/ComposePane";
import { SettingsPane } from "./ui/SettingsPane";
import { ConnectionSetup, Help, StatusBar, TopBar } from "./ui/Chrome";
import type { Draft, Message } from "./api/types";

/** A key belongs to a text field whenever one of these has focus. */
function isEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

export function App() {
  const store = createAppStore();
  const keymap = new Keymap(store.settings().bindings);

  const [showHelp, setShowHelp] = createSignal(false);
  const [mobilePane, setMobilePane] = createSignal<"list" | "detail">("list");

  const configured = () => store.connection().baseUrl !== "";
  const composing = () => store.right().kind === "compose";
  /** Settings takes the whole pane; compose is pinned below the thread. */
  const fullPane = () => store.right().kind === "settings";

  // Custom bindings take effect as soon as settings are applied.
  createEffect(() => keymap.replace(store.settings().bindings));

  onMount(() => {
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  // The desktop shell supplies the server URL after the first render, so the
  // event stream has to follow the connection rather than be opened once.
  createEffect(() => {
    store.connection().baseUrl;
    const unsubscribe = store.subscribe();
    onCleanup(unsubscribe);
  });

  function onKeyDown(event: KeyboardEvent) {
    // Ctrl chords always reach the app, even mid-edit, so focus can leave an
    // open composer without discarding it.
    if (event.ctrlKey && !event.metaKey && !event.altKey) {
      const outcome = keymap.handle({ key: event.key, ctrl: true }, "normal", false, store.pane());
      if (outcome.type === "action") {
        event.preventDefault();
        void dispatch(outcome.action);
        return;
      }
    }

    // Otherwise the editor owns every key while it is open.
    if (fullPane() || (composing() && store.pane() === "detail" && store.pinnedOpen())) return;

    if (event.key === "Escape" && showHelp()) {
      event.preventDefault();
      setShowHelp(false);
      return;
    }

    const outcome = keymap.handle(
      { key: event.key, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey },
      store.mode(),
      isEditing(event.target),
      store.pane(),
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

  function threadMessages(): Message[] {
    return store.thread()?.messages ?? [];
  }

  function openCompose(draft: Draft, label: string) {
    store.setRight({ kind: "compose", draft, label });
    store.setPinnedOpen(true);
    store.setPane("detail");
    setMobilePane("detail");
  }

  function closeRight() {
    store.setRight({ kind: "reading" });
    store.setMode("normal");
  }

  async function dispatch(action: Action) {
    const pane = store.pane();

    switch (action.kind) {
      case "focusLeft":
        store.focusPane(-1);
        setMobilePane(store.pane() === "detail" ? "detail" : "list");
        break;
      case "focusRight":
        store.focusPane(1);
        setMobilePane(store.pane() === "detail" ? "detail" : "list");
        break;

      case "togglePinned":
        store.setPinnedOpen(!store.pinnedOpen());
        break;
      case "focusPinned":
        if (composing()) {
          store.setPinnedOpen(true);
          store.setPane("detail");
        }
        break;

      case "next":
        if (pane === "sidebar") store.moveSidebar(1);
        else if (pane === "list") store.move(1);
        else store.setMessageIndex(Math.min(store.messageIndex() + 1, threadMessages().length - 1));
        break;
      case "prev":
        if (pane === "sidebar") store.moveSidebar(-1);
        else if (pane === "list") store.move(-1);
        else store.setMessageIndex(Math.max(store.messageIndex() - 1, 0));
        break;
      case "first":
        if (pane === "sidebar") store.setSidebarIndex(0);
        else if (pane === "list") store.setSelected(0);
        else store.setMessageIndex(0);
        break;
      case "last":
        if (pane === "sidebar") store.setSidebarIndex(store.sidebarRows().length - 1);
        else if (pane === "list") store.setSelected(Math.max(store.items().length - 1, 0));
        else store.setMessageIndex(Math.max(threadMessages().length - 1, 0));
        break;

      case "select":
        store.activateSidebar();
        break;

      case "open": {
        const thread = store.current();
        if (thread) {
          store.setOpenThread(thread.id);
          store.setRight({ kind: "reading" });
          store.setMessageIndex(0);
          store.setPane("detail");
          setMobilePane("detail");
        }
        break;
      }

      case "nextMessage":
        store.setMessageIndex(Math.min(store.messageIndex() + 1, threadMessages().length - 1));
        break;
      case "prevMessage":
        store.setMessageIndex(Math.max(store.messageIndex() - 1, 0));
        break;

      case "toggleFold": {
        if (pane === "sidebar") {
          store.activateSidebar();
          break;
        }
        const message = threadMessages()[store.messageIndex()];
        if (message) store.toggleCollapsed(message.id);
        break;
      }
      case "foldAll":
        store.setAllCollapsed(threadMessages().map((m) => m.id), true);
        break;
      case "unfoldAll":
        store.setAllCollapsed(threadMessages().map((m) => m.id), false);
        break;

      case "loadRemote":
        store.setAllowRemote(true);
        store.setStatus("remote images loaded");
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
        openCompose(emptyDraft(), "compose");
        break;

      case "reply":
      case "forward": {
        // Replying from the list is the common case: the thread the cursor is
        // on has usually not been opened yet, so fetch it rather than telling
        // the user to press Enter first.
        let messages = threadMessages();
        if (messages.length === 0) {
          const selected = store.current();
          if (selected) {
            store.setStatus("loading thread…");
            const fetched = await store.api.thread(selected.id).catch(() => null);
            messages = fetched?.messages ?? [];
            if (messages.length > 0) store.setOpenThread(selected.id);
          }
        }

        const message = messages[store.messageIndex()] ?? messages[messages.length - 1];
        if (!message) {
          store.setStatus("nothing to reply to");
          break;
        }
        const all = action.kind === "reply" && (action.all || store.settings().preferences.replyAll);
        openCompose(
          action.kind === "forward" ? forwardDraft(message) : replyDraft(message, all),
          action.kind === "forward" ? "forward" : all ? "reply all" : "reply",
        );
        break;
      }

      case "nextAccount":
        store.cycleAccount(1);
        break;
      case "prevAccount":
        store.cycleAccount(-1);
        break;

      case "settings":
        store.setRight({ kind: "settings" });
        store.setPane("detail");
        setMobilePane("detail");
        break;

      case "closeRight":
        closeRight();
        break;

      case "enterCommand":
        store.setMode("command");
        break;
      case "enterSearch":
        // Starts empty, like vim's `/`. Pre-filling with the current query
        // means the next keystroke appends to it instead of replacing it.
        store.setMode("search");
        store.setPalette("");
        break;
      case "help":
        setShowHelp(true);
        break;
    }
  }

  return (
    <Show when={configured()} fallback={<ConnectionSetup store={store} />}>
      <div class="relative flex h-full flex-col">
        <TopBar
          store={store}
          onSync={() => void store.sync()}
          onSettings={() => void dispatch({ kind: "settings" })}
        />

        <main class="grid min-h-0 flex-1 md:grid-cols-[14rem_minmax(0,1.05fr)_minmax(0,1.45fr)]">
          <div class="hidden min-h-0 md:block">
            <Sidebar
              store={store}
              onCompose={() => openCompose(emptyDraft(), "compose")}
              onSettings={() => void dispatch({ kind: "settings" })}
            />
          </div>

          <div
            class="min-h-0"
            classList={{ hidden: mobilePane() !== "list", "md:block": true }}
          >
            <ThreadList store={store} />
          </div>

          <div
            class="min-h-0"
            classList={{ hidden: mobilePane() !== "detail", "md:block": true }}
          >
            <section
              class="pane h-full"
              classList={{ "pane-focused": store.pane() === "detail" }}
              onClick={() => store.setPane("detail")}
            >
              <Switch>
                <Match when={store.right().kind === "settings"}>
                  <SettingsPane store={store} onClose={closeRight} />
                </Match>
                <Match when={true}>
                  {/*
                    The thread stays mounted while composing, so a reply can be
                    written with the conversation still on screen and still
                    navigable.
                  */}
                  <div class="flex min-h-0 flex-1 flex-col">
                    <ReadingPane store={store} />
                  </div>

                  <Show when={composing()}>
                    {(() => {
                      const right = store.right();
                      if (right.kind !== "compose") return null;

                      return (
                        <Show
                          when={store.pinnedOpen()}
                          fallback={
                            <button
                              type="button"
                              class="flex shrink-0 items-center gap-2 border-t border-obligation bg-paper-2 px-4 py-1.5 text-xs text-obligation"
                              onClick={() => store.setPinnedOpen(true)}
                            >
                              ▴ {right.label} minimised — <kbd>C-p</kbd> to show
                            </button>
                          }
                        >
                          <div
                            class="flex shrink-0 flex-col border-t-2 border-obligation"
                            style={{ height: "45%" }}
                          >
                            <ComposePane
                              store={store}
                              draft={right.draft}
                              label={right.label}
                              onClose={closeRight}
                            />
                          </div>
                        </Show>
                      );
                    })()}
                  </Show>
                </Match>
              </Switch>
            </section>
          </div>
        </main>

        <StatusBar store={store} />
        <Palette store={store} />

        <Show when={showHelp()}>
          <Help
            bindings={keymap.describe(store.pane())}
            pane={store.pane()}
            onClose={() => setShowHelp(false)}
          />
        </Show>
      </div>
    </Show>
  );
}

function replyDraft(message: Message, all: boolean): Draft {
  const to = (message.reply_to.length ? message.reply_to : message.from).map((a) => a.email);
  return {
    to,
    cc: all ? message.cc.map((a) => a.email).filter((e) => !to.includes(e)) : [],
    bcc: [],
    subject: prefixed(message.subject, "Re:"),
    body: `\n\nOn ${message.date}, ${message.from[0]?.email ?? "someone"} wrote:\n${quote(message)}`,
    in_reply_to: message.id,
    references: [...message.references, message.id],
  };
}

function forwardDraft(message: Message): Draft {
  return {
    to: [],
    cc: [],
    bcc: [],
    subject: prefixed(message.subject, "Fwd:"),
    body:
      `\n\n---------- Forwarded message ----------\n` +
      `From: ${message.from.map((a) => a.email).join(", ")}\n` +
      `Date: ${message.date}\n` +
      `Subject: ${message.subject}\n` +
      `To: ${message.to.map((a) => a.email).join(", ")}\n\n`,
    in_reply_to: null,
    references: [],
  };
}

function quote(message: Message): string {
  return `> (${message.subject})\n`;
}

function prefixed(subject: string, prefix: string): string {
  const trimmed = subject.trim();
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase())
    ? trimmed
    : `${prefix} ${trimmed}`;
}
