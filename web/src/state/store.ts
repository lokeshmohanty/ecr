import { createSignal, createResource, batch } from "solid-js";
import { createStore } from "solid-js/store";
import { Api, loadConnection, saveConnection, type Connection } from "../api/client";
import type { Account, ServerEvent, ThreadSummary } from "../api/types";
import type { Mode } from "../keymap/engine";

export type Mark = "archive" | "delete" | "read" | "unread" | "flag";

export interface MarkQueue {
  [messageId: string]: Mark[];
}

export const MARK_TAGS: Record<Mark, { add: string[]; remove: string[]; badge: string }> = {
  archive: { add: [], remove: ["inbox"], badge: "A" },
  delete: { add: ["deleted"], remove: ["inbox"], badge: "D" },
  read: { add: [], remove: ["unread"], badge: "R" },
  unread: { add: ["unread"], remove: [], badge: "U" },
  flag: { add: ["flagged"], remove: [], badge: "F" },
};

export function markToOps(queue: MarkQueue) {
  return Object.entries(queue)
    .map(([id, marks]) => {
      const add = new Set<string>();
      const remove = new Set<string>();
      for (const mark of marks) {
        for (const tag of MARK_TAGS[mark].add) add.add(tag);
        for (const tag of MARK_TAGS[mark].remove) remove.add(tag);
      }
      for (const tag of add) remove.delete(tag);
      return { id, add: [...add], remove: [...remove] };
    })
    .filter((op) => op.add.length > 0 || op.remove.length > 0);
}

export interface View {
  name: string;
  query: string;
}

export const DEFAULT_VIEWS: View[] = [
  { name: "INBOX", query: "tag:inbox" },
  { name: "UNREAD", query: "tag:unread" },
  { name: "FLAGGED", query: "tag:flagged" },
  { name: "TODAY", query: "date:today" },
  { name: "SENT", query: "tag:sent" },
  { name: "DRAFTS", query: "tag:draft" },
  { name: "ARCHIVE", query: "not tag:inbox and not tag:trash" },
  { name: "ALL", query: "*" },
];

export function createAppStore() {
  const [connection, setConnectionSignal] = createSignal<Connection>(loadConnection());
  const api = new Api(connection());

  const [query, setQuery] = createSignal("tag:inbox");
  const [revision, setRevision] = createSignal(0);
  const [mode, setMode] = createSignal<Mode>("normal");
  const [palette, setPalette] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const [openThread, setOpenThread] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal("");
  const [pendingKeys, setPendingKeys] = createSignal("");
  const [allowRemote, setAllowRemote] = createSignal(false);
  const [syncing, setSyncing] = createSignal(false);
  const [marks, setMarks] = createStore<MarkQueue>({});
  const [connected, setConnected] = createSignal(false);

  const [accounts] = createResource<Account[]>(() => api.accounts().catch(() => []));

  const [threads, { refetch: refetchThreads }] = createResource(
    () => [query(), revision()] as const,
    async ([q]) => {
      try {
        const page = await api.threads(q);
        setConnected(true);
        return page;
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "request failed");
        setConnected(false);
        return { revision: { uuid: "", lastmod: 0 }, total: 0, items: [] as ThreadSummary[] };
      }
    },
  );

  const [thread] = createResource(
    () => [openThread(), revision()] as const,
    async ([id]) => (id ? api.thread(id).catch(() => null) : null),
  );

  function setConnection(next: Connection) {
    saveConnection(next);
    api.update(next);
    setConnectionSignal(next);
    bumpRevision();
  }

  function bumpRevision() {
    setRevision((r) => r + 1);
  }

  function items(): ThreadSummary[] {
    return threads()?.items ?? [];
  }

  function current(): ThreadSummary | undefined {
    return items()[selected()];
  }

  function move(delta: number) {
    const total = items().length;
    if (total === 0) return;
    setSelected((s) => Math.min(Math.max(s + delta, 0), total - 1));
  }

  function mark(mark: Mark) {
    const thread = current();
    if (!thread?.newest_message) return;
    const id = thread.newest_message;
    const existing = marks[id] ?? [];
    setMarks(id, existing.includes(mark) ? existing.filter((m) => m !== mark) : [...existing, mark]);
    setStatus(`${Object.keys(marks).length} marked`);
  }

  async function executeMarks() {
    const ops = markToOps(marks);
    if (ops.length === 0) {
      setStatus("nothing marked");
      return;
    }
    try {
      await api.tag(ops);
      batch(() => {
        setMarks({});
        setStatus(`applied ${ops.length}`);
        bumpRevision();
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "tagging failed");
    }
  }

  function clearMarks() {
    setMarks({});
    setStatus("marks cleared");
  }

  async function applyNow(add: string[], remove: string[]) {
    const thread = current();
    if (!thread?.newest_message) return;
    try {
      await api.tag([{ id: thread.newest_message, add, remove }]);
      bumpRevision();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "tagging failed");
    }
  }

  async function sync() {
    setSyncing(true);
    setStatus("syncing");
    try {
      const report = await api.sync();
      setStatus(`synced: ${report.new_messages} new`);
      bumpRevision();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "sync failed");
    } finally {
      setSyncing(false);
    }
  }

  function onServerEvent(event: ServerEvent) {
    switch (event.type) {
      case "mail_changed":
      case "tags_changed":
        bumpRevision();
        break;
      case "sync_started":
        setSyncing(true);
        setStatus("syncing");
        break;
      case "sync_progress":
        setStatus(event.line);
        break;
      case "sync_finished":
        setSyncing(false);
        setStatus(`synced: ${event.new_messages} new`);
        bumpRevision();
        break;
      case "error":
        setStatus(event.detail);
        break;
    }
  }

  function subscribe() {
    return api.events(onServerEvent, () => setConnected(false));
  }

  return {
    api,
    connection,
    setConnection,
    query,
    setQuery,
    revision,
    bumpRevision,
    mode,
    setMode,
    palette,
    setPalette,
    selected,
    setSelected,
    openThread,
    setOpenThread,
    status,
    setStatus,
    pendingKeys,
    setPendingKeys,
    allowRemote,
    setAllowRemote,
    syncing,
    connected,
    accounts,
    threads,
    thread,
    refetchThreads,
    items,
    current,
    move,
    marks,
    mark,
    executeMarks,
    clearMarks,
    applyNow,
    sync,
    subscribe,
  };
}

export type AppStore = ReturnType<typeof createAppStore>;
