import { createEffect, batch, createResource, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { Api, loadConnection, saveConnection, type Connection } from "../api/client";
import { shellServerUrl } from "../api/platform";
import type { Account, Draft, ServerEvent, ThreadSummary } from "../api/types";
import type { Mode, Pane } from "../keymap/engine";
import {
  fromToml,
  loadSettings,
  loadSettingsText,
  saveSettings,
  toToml,
  type Settings,
} from "./settings";
import { ALL_ACCOUNTS, accountLabel, buildTree, type ViewGroup } from "./views";
import { parseAddress, type AddressEntry } from "./suggest";
import { effectiveFormat, toggled, type MessageFormat } from "./format";

export type Mark = "archive" | "delete" | "read" | "unread" | "flag";

export interface MarkQueue {
  [messageId: string]: Mark[];
}

/** What the right-hand pane is showing. */
export type RightPane =
  | { kind: "reading" }
  | { kind: "compose"; draft: Draft; label: string }
  | { kind: "settings" };

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

export const PANES: Pane[] = ["sidebar", "list", "detail"];

/** How long the cursor must rest before the thread under it is opened. */
export const FOLLOW_DELAY = 140;

export function createAppStore() {
  const [connection, setConnectionSignal] = createSignal<Connection>(loadConnection());
  const api = new Api(connection());

  const [settings, setSettingsSignal] = createSignal<Settings>(loadSettings());
  /**
   * The file as written, not as parsed. Editing the text rather than
   * regenerating it is what lets the user's own comments and ordering survive
   * a toggle on the settings page.
   */
  const [settingsSource, setSettingsSource] = createSignal(loadSettingsText());

  const [query, setQuery] = createSignal(settings().preferences.startQuery);
  const [revision, setRevision] = createSignal(0);
  const [mode, setMode] = createSignal<Mode>("normal");
  const [pane, setPane] = createSignal<Pane>("list");
  const [right, setRight] = createSignal<RightPane>({ kind: "reading" });
  const [palette, setPalette] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const [sidebarIndex, setSidebarIndex] = createSignal(0);
  const [messageIndex, setMessageIndex] = createSignal(0);
  const [expandedAccount, setExpandedAccount] = createSignal<string | null>(null);
  const [openThread, setOpenThread] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal("");
  const [pendingKeys, setPendingKeys] = createSignal("");
  const [allowRemote, setAllowRemote] = createSignal(settings().preferences.loadRemoteImages);
  const [syncing, setSyncing] = createSignal(false);
  const [marks, setMarks] = createStore<MarkQueue>({});
  const [connected, setConnected] = createSignal(false);
  const [lastError, setLastError] = createSignal("");
  const [collapsed, setCollapsed] = createStore<Record<string, boolean>>({});
  /** Per-message format overrides, by id. Absent means follow the preference. */
  const [formatOverride, setFormatOverride] = createStore<Record<string, MessageFormat>>({});
  /** The detail pane's scroll container, so keys can drive it. */
  const [detailScroller, setDetailScroller] = createSignal<HTMLElement | null>(null);
  const [pinnedOpen, setPinnedOpen] = createSignal(true);
  const [expandedGroup, setExpandedGroup] = createSignal<string>(ALL_ACCOUNTS);

  // Under Tauri there is no usable origin, so the shell supplies the URL.
  if (connection().baseUrl === "") {
    void shellServerUrl().then((url) => {
      if (url) setConnection({ ...connection(), baseUrl: url });
    });
  }

  // Every request source keys on the base URL as well as the revision. Under
  // Tauri the URL arrives asynchronously from the shell, so a resource that
  // does not depend on it fires once against an empty base and never retries.
  const [accounts] = createResource(
    () => connection().baseUrl,
    async (baseUrl) => (baseUrl ? await api.accounts().catch(() => []) : ([] as Account[])),
  );

  const [threads] = createResource(
    () => [query(), revision(), connection().baseUrl] as const,
    async ([q, , baseUrl]) => {
      if (!baseUrl) {
        return { revision: { uuid: "", lastmod: 0 }, total: 0, items: [] as ThreadSummary[] };
      }
      try {
        const page = await api.threads(q, settings().preferences.pageSize);
        setConnected(true);
        setLastError("");
        return page;
      } catch (error) {
        const message = error instanceof Error ? error.message : "request failed";
        setStatus(message);
        setLastError(message);
        setConnected(false);
        return { revision: { uuid: "", lastmod: 0 }, total: 0, items: [] as ThreadSummary[] };
      }
    },
  );

  const [addressBook] = createResource(
    () => connection().baseUrl,
    async (baseUrl) => {
      if (!baseUrl) return [] as AddressEntry[];
      const raw = await api.addresses().catch(() => []);
      return raw
        .map((a) => (a.name ? parseAddress(`${a.name} <${a.email}>`) : parseAddress(a.email)))
        .filter((a): a is AddressEntry => a !== null);
    },
  );

  const [allTags] = createResource(
    () => [connection().baseUrl, revision()] as const,
    async ([baseUrl]) => (baseUrl ? await api.tags().catch(() => []) : ([] as string[])),
  );

  const [thread] = createResource(
    () => [openThread(), revision(), connection().baseUrl] as const,
    async ([id, , baseUrl]) => (id && baseUrl ? await api.threadCached(id).catch(() => null) : null),
  );

  function setConnection(next: Connection) {
    saveConnection(next);
    api.update(next);
    setConnectionSignal(next);
    bumpRevision();
  }

  function setSettings(next: Settings, source = toToml(next)) {
    saveSettings(next, source);
    setSettingsSignal(next);
    setSettingsSource(source);
    setAllowRemote(next.preferences.loadRemoteImages);
    bumpRevision();
    void api.saveConfig(source).catch(() => setLastError("settings could not reach the server"));
  }

  /** Applies edited text, or reports why it cannot. */
  function applySettingsText(text: string): string[] {
    const { settings: parsed, errors } = fromToml(text);
    if (errors.length === 0) setSettings(parsed, text);
    return errors;
  }

  // The file lives on the server, so browser, desktop and phone read the same
  // one. An empty file is a first run: seed it with the commented default.
  createEffect(() => {
    if (!connection().baseUrl) return;
    void (async () => {
      try {
        const file = await api.config();
        if (file.raw.trim() === "") {
          await api.saveConfig(settingsSource());
          return;
        }
        const { settings: parsed, errors } = fromToml(file.raw);
        saveSettings(parsed, file.raw);
        setSettingsSignal(parsed);
        setSettingsSource(file.raw);
        setAllowRemote(parsed.preferences.loadRemoteImages);
        if (errors.length > 0) setLastError(`${file.path}: ${errors[0]}`);
      } catch {
        // Offline, or an old server: the local copy stands.
      }
    })();
  });

  function bumpRevision() {
    api.invalidate();
    setRevision((r) => r + 1);
  }

  function items(): ThreadSummary[] {
    return threads()?.items ?? [];
  }

  function current(): ThreadSummary | undefined {
    return items()[selected()];
  }

  let followTimer: number | undefined;

  function move(delta: number) {
    const total = items().length;
    if (total === 0) return;

    const next = Math.min(Math.max(selected() + delta, 0), total - 1);
    setSelected(next);

    // Holding j would otherwise open every row it passes over. Waiting for the
    // cursor to settle turns a burst of requests into one.
    if (followTimer !== undefined) clearTimeout(followTimer);
    followTimer = window.setTimeout(() => followSelection(selected()), FOLLOW_DELAY);
  }

  /**
   * Opens whatever the cursor lands on, so moving through the list reads as
   * browsing rather than a two-step select-then-open.
   */
  function followSelection(index: number) {
    if (!settings().preferences.followSelection) return;
    if (right().kind !== "reading") return;

    const thread = items()[index];
    if (thread) {
      setOpenThread(thread.id);
      setMessageIndex(0);
    }
  }

  function tree(): ViewGroup[] {
    return buildTree(accounts() ?? []);
  }

  /** Which account the current query is showing, for the footer. */
  function currentAccount(): string {
    return accountLabel(query(), accounts() ?? []);
  }

  /**
   * Flattened sidebar rows: each account header, then its views when expanded.
   * Flattening keeps j/k a single index rather than a nested cursor.
   */
  function sidebarRows(): { kind: "group" | "view"; name: string; group: string; query: string }[] {
    const rows: { kind: "group" | "view"; name: string; group: string; query: string }[] = [];

    for (const group of tree()) {
      rows.push({
        kind: "group",
        name: group.account,
        group: group.account,
        query: group.views[0]?.query ?? "*",
      });

      if (expandedGroup() === group.account) {
        for (const view of group.views) {
          rows.push({ kind: "view", name: view.name, group: group.account, query: view.query });
        }
      }
    }
    return rows;
  }

  function moveSidebar(delta: number) {
    const total = sidebarRows().length;
    if (total === 0) return;
    setSidebarIndex((i) => Math.min(Math.max(i + delta, 0), total - 1));
  }

  function activateSidebar() {
    const row = sidebarRows()[sidebarIndex()];
    if (!row) return;

    if (row.kind === "group") {
      setExpandedGroup(row.group);
    }
    selectQuery(row.query);
  }

  /**
   * A draft is the reader's own work, so navigating never discards it — only
   * sending, ZQ or the close button does. Settings has nothing to lose, so
   * moving away closes it.
   */
  function leaveRightPane() {
    if (right().kind !== "compose") setRight({ kind: "reading" });
  }

  function selectQuery(next: string) {
    batch(() => {
      setQuery(next);
      setSelected(0);
      setOpenThread(null);
      leaveRightPane();
    });
  }

  function focusPane(delta: number) {
    const index = PANES.indexOf(pane());
    const next = PANES[Math.min(Math.max(index + delta, 0), PANES.length - 1)];
    if (next) setPane(next);
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

  /**
   * Which account a message belongs to. The post-new hook tags every message
   * with its account, so replying from the right address is a tag lookup
   * rather than a guess — picking accounts()[0] meant replying to a Gmail
   * thread from the work address purely because it sorts first.
   */
  function accountForTags(tags: string[] | undefined): Account | undefined {
    const list = accounts() ?? [];
    return (
      (tags && list.find((a) => tags.includes(a.id))) ??
      list.find((a) => a.id === "main") ??
      list[0]
    );
  }

  function sendingAccount(): Account | undefined {
    const openTags = thread()?.messages.at(-1)?.tags;
    return accountForTags(openTags ?? current()?.tags);
  }

  async function send(draft: Draft, account?: Account): Promise<boolean> {
    const from = account ?? sendingAccount();
    if (!from) {
      setStatus("no account available to send from");
      return false;
    }
    try {
      await api.send(from.id, draft);
      setStatus(`sent from ${from.address ?? from.id}`);
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "send failed");
      return false;
    }
  }

  /** The format a message is shown in right now. */
  function messageFormat(id: string): MessageFormat {
    return effectiveFormat(formatOverride[id], settings().preferences.preferHtml);
  }

  function toggleFormat(id: string): MessageFormat {
    const next = toggled(formatOverride[id], settings().preferences.preferHtml);
    setFormatOverride(id, next);
    return next;
  }

  /** One line, or half a screen. Matches vim's C-e and C-d. */
  function scrollDetail(direction: 1 | -1, half = false) {
    const element = detailScroller();
    if (!element) return;

    const step = half ? element.clientHeight / 2 : 64;
    element.scrollBy({ top: direction * step, behavior: "auto" });
  }

  /**
   * Drops the unread tag once a message has actually been on screen. The delay
   * is what keeps scrolling past a thread from marking it read.
   */
  const markReadTimers = new Map<string, number>();

  function markReadWhenSeen(id: string, tags: string[]) {
    const { markReadOnOpen, markReadDelay } = settings().preferences;
    if (!markReadOnOpen || !tags.includes("unread")) return;
    if (markReadTimers.has(id)) return;

    const timer = window.setTimeout(async () => {
      markReadTimers.delete(id);
      try {
        await api.tag([{ id, add: [], remove: ["unread"] }]);
        bumpRevision();
      } catch {
        // A read-only server refuses this; it is not worth a message.
      }
    }, markReadDelay);

    markReadTimers.set(id, timer);
  }

  function cancelMarkRead(id: string) {
    const timer = markReadTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      markReadTimers.delete(id);
    }
  }

  function toggleCollapsed(id: string) {
    setCollapsed(id, (v) => !v);
  }

  function setAllCollapsed(ids: string[], value: boolean) {
    batch(() => {
      for (const id of ids) setCollapsed(id, value);
    });
  }

  function cycleAccount(delta: number) {
    const list = accounts() ?? [];
    if (list.length === 0) return;
    const match = /^tag:(\w+)$/.exec(query());
    const at = match ? list.findIndex((a) => a.id === match[1]) : -1;
    const next = list[(at + delta + list.length * 2) % list.length];
    if (next) {
      selectQuery(`tag:${next.id}`);
      setStatus(`account ${next.id}`);
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
    if (!connection().baseUrl) return () => {};
    return api.events(onServerEvent, () => setConnected(false));
  }

  return {
    api,
    connection,
    setConnection,
    settings,
    setSettings,
    settingsSource,
    applySettingsText,
    query,
    setQuery,
    selectQuery,
    revision,
    bumpRevision,
    mode,
    setMode,
    pane,
    setPane,
    focusPane,
    right,
    setRight,
    leaveRightPane,
    palette,
    setPalette,
    selected,
    setSelected,
    followSelection,
    pinnedOpen,
    setPinnedOpen,
    expandedGroup,
    setExpandedGroup,
    tree,
    currentAccount,
    addressBook,
    allTags,
    sidebarIndex,
    setSidebarIndex,
    sidebarRows,
    moveSidebar,
    activateSidebar,
    expandedAccount,
    setExpandedAccount,
    messageIndex,
    setMessageIndex,
    openThread,
    setOpenThread,
    status,
    setStatus,
    lastError,
    pendingKeys,
    setPendingKeys,
    allowRemote,
    setAllowRemote,
    syncing,
    connected,
    accounts,
    threads,
    thread,
    items,
    current,
    move,
    marks,
    mark,
    executeMarks,
    clearMarks,
    applyNow,
    sync,
    send,
    sendingAccount,
    accountForTags,
    collapsed,
    detailScroller,
    setDetailScroller,
    scrollDetail,
    markReadWhenSeen,
    cancelMarkRead,
    formatOverride,
    messageFormat,
    toggleFormat,
    toggleCollapsed,
    setAllCollapsed,
    cycleAccount,
    subscribe,
  };
}

export type AppStore = ReturnType<typeof createAppStore>;
