import { createEffect, batch, createResource, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
	Api,
	loadConnection,
	saveConnection,
	type Connection,
} from "../api/client";
import { shellServerUrl } from "../api/platform";
import type { Account, Draft, ServerEvent, ThreadSummary } from "../api/types";
import type { Mode, Pane } from "../keymap/engine";
import {
	fromToml,
	loadSettings,
	loadSettingsText,
	saveSettings,
	toToml,
	withValue,
	type Settings,
} from "./settings";
import {
	applyTheme,
	loadThemeText,
	parseTheme,
	saveThemeText,
} from "./theme";
import { ALL_ACCOUNTS, accountLabel, buildTree, type ViewGroup } from "./views";
import { parseAddress, type AddressEntry } from "./suggest";
import { effectiveFormat, toggled, type MessageFormat } from "./format";

export type Mark = "archive" | "delete" | "read" | "unread" | "flag";

/**
 * What is staged against one message: presets, which toggle, and whatever
 * arbitrary tags were typed at the prompt.
 */
export interface Staged {
	marks: Mark[];
	add: string[];
	remove: string[];
}

export interface MarkQueue {
	[messageId: string]: Staged;
}

export function emptyStaged(): Staged {
	return { marks: [], add: [], remove: [] };
}

/** `+work`, `-inbox`, or a bare tag meaning add. */
export function parseTagInput(input: string): {
	add: string[];
	remove: string[];
} {
	const add: string[] = [];
	const remove: string[] = [];

	for (const word of input.split(/[\s,]+/).filter(Boolean)) {
		if (word.startsWith("-")) {
			if (word.length > 1) remove.push(word.slice(1));
		} else {
			const tag = word.startsWith("+") ? word.slice(1) : word;
			if (tag) add.push(tag);
		}
	}
	return { add, remove };
}

export function badgesFor(staged: Staged | undefined): string {
	if (!staged) return "";
	const presets = staged.marks.map((m) => MARK_TAGS[m].badge).join("");
	const tagged = staged.add.length > 0 || staged.remove.length > 0 ? "T" : "";
	return presets + tagged;
}

/** What the right-hand pane is showing. */
export type RightPane =
	| { kind: "reading" }
	| { kind: "compose"; draft: Draft; label: string }
	| { kind: "settings" };

export const MARK_TAGS: Record<
	Mark,
	{ add: string[]; remove: string[]; badge: string }
> = {
	archive: { add: [], remove: ["inbox"], badge: "A" },
	delete: { add: ["deleted"], remove: ["inbox"], badge: "D" },
	read: { add: [], remove: ["unread"], badge: "R" },
	unread: { add: ["unread"], remove: [], badge: "U" },
	flag: { add: ["flagged"], remove: [], badge: "F" },
};

export function markToOps(queue: MarkQueue) {
	return Object.entries(queue)
		.map(([id, staged]) => {
			const add = new Set<string>(staged.add);
			const remove = new Set<string>(staged.remove);
			for (const mark of staged.marks) {
				for (const tag of MARK_TAGS[mark].add) add.add(tag);
				for (const tag of MARK_TAGS[mark].remove) remove.add(tag);
			}
			// Adding a tag wins over removing it, so `u` after `r` reads as unread.
			for (const tag of add) remove.delete(tag);
			return { id, add: [...add], remove: [...remove] };
		})
		.filter((op) => op.add.length > 0 || op.remove.length > 0);
}

/**
 * Whether a message is showing, given any explicit fold and the default for
 * its position. The fold key has to agree with this: flipping the stored
 * boolean turned an absent entry into `true`, which reads as collapsed, so
 * `za` on an already-collapsed message did nothing at all.
 */
export function isMessageOpen(
	explicit: boolean | undefined,
	newest: boolean,
	expandNewest: boolean,
): boolean {
	if (explicit !== undefined) return !explicit;
	return newest && expandNewest;
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
	const [connection, setConnectionSignal] = createSignal<Connection>(
		loadConnection(),
	);
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
	const [expandedAccount, setExpandedAccount] = createSignal<string | null>(
		null,
	);
	const [openThread, setOpenThread] = createSignal<string | null>(null);
	const [status, setStatus] = createSignal("");
	const [pendingKeys, setPendingKeys] = createSignal("");
	const [allowRemote, setAllowRemote] = createSignal(
		settings().preferences.loadRemoteImages,
	);
	const [syncing, setSyncing] = createSignal(false);
	const [marks, setMarks] = createStore<MarkQueue>({});
	/** Rows picked one at a time with Space, by thread id. */
	const [picked, setPicked] = createSignal<string[]>([]);
	/** Where a v/V range started, or null when no range is being drawn. */
	const [visualAnchor, setVisualAnchor] = createSignal<number | null>(null);
	const [connected, setConnected] = createSignal(false);
	const [lastError, setLastError] = createSignal("");
	const [collapsed, setCollapsed] = createStore<Record<string, boolean>>({});
	/** Per-message format overrides, by id. Absent means follow the preference. */
	const [formatOverride, setFormatOverride] = createStore<
		Record<string, MessageFormat>
	>({});
	/** The detail pane's scroll container, so keys can drive it. */
	const [detailScroller, setDetailScroller] = createSignal<HTMLElement | null>(
		null,
	);
	/** Whether the detail pane has a text cursor in the message being read. */
	const [viewing, setViewing] = createSignal(false);
	const [pinnedOpen, setPinnedOpen] = createSignal(true);
	const [expandedGroup, setExpandedGroup] = createSignal<string>(ALL_ACCOUNTS);

	// Under Tauri there is no usable origin, so the shell supplies the URL.
	// ECR_SERVER_URL is the authoritative server for a desktop launch, so a
	// value persisted from an earlier run must not shadow it — only the auth
	// token is kept from storage. Outside Tauri, shellServerUrl() is null.
	void shellServerUrl().then((url) => {
		if (url && url !== connection().baseUrl)
			setConnection({ ...connection(), baseUrl: url });
	});

	// Every request source keys on the base URL as well as the revision. Under
	// Tauri the URL arrives asynchronously from the shell, so a resource that
	// does not depend on it fires once against an empty base and never retries.
	const [accounts] = createResource(
		() => connection().baseUrl,
		async (baseUrl) =>
			baseUrl ? await api.accounts().catch(() => []) : ([] as Account[]),
	);

	const [threads] = createResource(
		() => [query(), revision(), connection().baseUrl] as const,
		async ([q, , baseUrl]) => {
			if (!baseUrl) {
				return {
					revision: { uuid: "", lastmod: 0 },
					total: 0,
					items: [] as ThreadSummary[],
				};
			}
			try {
				const page = await api.threads(q, settings().preferences.pageSize);
				setConnected(true);
				// The desktop shell hands over the real server URL a moment after
				// the page loads, so the first query can go to the wrong place and
				// fail. Recovering has to retract the complaint as well, or the
				// status bar reads "Load failed" over a list that loaded fine.
				if (lastError() && status() === lastError()) setStatus("");
				setLastError("");
				return page;
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "request failed";
				setStatus(message);
				setLastError(message);
				setConnected(false);
				return {
					revision: { uuid: "", lastmod: 0 },
					total: 0,
					items: [] as ThreadSummary[],
				};
			}
		},
	);

	const [addressBook] = createResource(
		() => connection().baseUrl,
		async (baseUrl) => {
			if (!baseUrl) return [] as AddressEntry[];
			const raw = await api.addresses().catch(() => []);
			return raw
				.map((a) =>
					a.name
						? parseAddress(`${a.name} <${a.email}>`)
						: parseAddress(a.email),
				)
				.filter((a): a is AddressEntry => a !== null);
		},
	);

	const [allTags] = createResource(
		() => [connection().baseUrl, revision()] as const,
		async ([baseUrl]) =>
			baseUrl ? await api.tags().catch(() => []) : ([] as string[]),
	);

	const [thread] = createResource(
		() => [openThread(), revision(), connection().baseUrl] as const,
		async ([id, , baseUrl]) =>
			id && baseUrl ? await api.threadCached(id).catch(() => null) : null,
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
		void api
			.saveConfig(source)
			.catch(() => setLastError("settings could not reach the server"));
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

	// Tailwind compiles every utility to var(--color-*), so writing the theme's
	// values onto the root element restyles the app without a component knowing
	// a theme exists. The cached copy is applied first so startup does not paint
	// the built-in palette and then flip to the chosen one.
	createEffect(() => {
		const cached = loadThemeText();
		if (cached !== "") applyTheme(parseTheme(cached).theme, document.documentElement);
	});

	createEffect(() => {
		const path = settings().preferences.theme;
		if (!connection().baseUrl || path.trim() === "") return;

		void (async () => {
			try {
				const file = await api.theme(path);
				const { theme, errors } = parseTheme(file.raw);
				if (errors.length > 0) {
					setLastError(`${file.path}: ${errors[0]}`);
					return;
				}
				applyTheme(theme, document.documentElement);
				saveThemeText(file.raw);
			} catch {
				setLastError(`theme ${path} could not be read`);
			}
		})();
	});

	const [themeList] = createResource(
		() => connection().baseUrl || null,
		async () => (await api.themes()).presets,
	);

	/**
	 * Writes the one line, so picking a theme on this page never costs the user
	 * the comments they wrote around it. The effect above does the applying.
	 */
	function setTheme(path: string) {
		const text = withValue(
			settingsSource(),
			"[appearance]",
			"theme",
			JSON.stringify(path),
		);
		applySettingsText(text);
	}

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
		followTimer = window.setTimeout(
			() => followSelection(selected()),
			FOLLOW_DELAY,
		);
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

	/**
	 * A new page opens whatever the cursor is on. Changing mailbox clears the
	 * open thread and the page that replaces it arrives asynchronously, so
	 * without this the detail pane stayed empty until the next keystroke.
	 */
	createEffect(() => {
		const page = threads();
		if (!page || page.items.length === 0) return;
		if (!settings().preferences.followSelection) return;
		if (right().kind !== "reading") return;

		const open = openThread();
		if (open && page.items.some((t) => t.id === open)) return;

		const target = page.items[selected()] ?? page.items[0];
		if (target) {
			setOpenThread(target.id);
			setMessageIndex(0);
		}
	});

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
	function sidebarRows(): {
		kind: "group" | "view";
		name: string;
		group: string;
		query: string;
	}[] {
		const rows: {
			kind: "group" | "view";
			name: string;
			group: string;
			query: string;
		}[] = [];

		for (const group of tree()) {
			rows.push({
				kind: "group",
				name: group.account,
				group: group.account,
				query: group.views[0]?.query ?? "*",
			});

			if (expandedGroup() === group.account) {
				for (const view of group.views) {
					rows.push({
						kind: "view",
						name: view.name,
						group: group.account,
						query: view.query,
					});
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

	/**
	 * The rows an action applies to: everything picked with Space, plus whatever
	 * a v/V range currently covers. With nothing selected it is the row under the
	 * cursor, so every key still works one message at a time.
	 */
	function selectionIndices(): number[] {
		const list = items();
		const chosen = new Set<number>();

		const ids = new Set(picked());
		list.forEach((thread, index) => {
			if (ids.has(thread.id)) chosen.add(index);
		});

		const anchor = visualAnchor();
		if (anchor !== null) {
			const from = Math.min(anchor, selected());
			const to = Math.max(anchor, selected());
			for (let i = from; i <= to && i < list.length; i++) chosen.add(i);
		}

		return [...chosen].sort((a, b) => a - b);
	}

	function targets(): ThreadSummary[] {
		const indices = selectionIndices();
		if (indices.length === 0) {
			const thread = current();
			return thread ? [thread] : [];
		}
		return indices
			.map((i) => items()[i])
			.filter((t): t is ThreadSummary => t !== undefined);
	}

	function isSelected(index: number): boolean {
		return selectionIndices().includes(index);
	}

	function toggleSelect() {
		const thread = current();
		if (!thread) return;

		setPicked((list) =>
			list.includes(thread.id)
				? list.filter((id) => id !== thread.id)
				: [...list, thread.id],
		);
		setStatus(`${selectionIndices().length} selected`);
	}

	/** `v` starts a range where the cursor is, and `v` again abandons it. */
	function startVisual() {
		const started = visualAnchor() === null;
		setVisualAnchor(started ? selected() : null);
		setStatus(started ? "visual" : "");
	}

	/** Escape abandons a range being drawn without touching what is staged. */
	function clearVisual() {
		if (visualAnchor() === null) return;
		setVisualAnchor(null);
		setStatus("");
	}

	function clearSelection() {
		batch(() => {
			setPicked([]);
			setVisualAnchor(null);
			setMarks(reconcile({}));
			setStatus("selection cleared");
		});
	}

	/** Stages a preset against every selected row, toggling it off if it is on. */
	function mark(mark: Mark) {
		const chosen = targets();
		if (chosen.length === 0) return;

		batch(() => {
			for (const thread of chosen) {
				const id = thread.newest_message;
				if (!id) continue;

				const staged = marks[id] ?? emptyStaged();
				const marked = staged.marks.includes(mark);
				setMarks(id, {
					...staged,
					marks: marked
						? staged.marks.filter((m) => m !== mark)
						: [...staged.marks, mark],
				});
			}
			// A range is drawn for one action; the rows picked with Space persist.
			setVisualAnchor(null);
			setStatus(`${Object.keys(marks).length} staged`);
		});
	}

	/** Stages arbitrary tags, from `+work -inbox` typed at the prompt. */
	function stageTags(input: string) {
		const { add, remove } = parseTagInput(input);
		if (add.length === 0 && remove.length === 0) {
			setStatus("nothing to tag");
			return;
		}

		const chosen = targets();
		batch(() => {
			for (const thread of chosen) {
				const id = thread.newest_message;
				if (!id) continue;

				const staged = marks[id] ?? emptyStaged();
				setMarks(id, {
					...staged,
					add: [...new Set([...staged.add, ...add])],
					remove: [...new Set([...staged.remove, ...remove])],
				});
			}
			setVisualAnchor(null);
			setStatus(`staged on ${chosen.length}`);
		});
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
				setMarks(reconcile({}));
				setPicked([]);
				setVisualAnchor(null);
				setStatus(`applied ${ops.length}`);
				bumpRevision();
			});
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "tagging failed");
		}
	}

	/**
	 * Applies to every selected row at once, rather than only the one under the
	 * cursor. Reports whether it went through: a write that changes a tag the
	 * reader cannot see is otherwise indistinguishable from a key that did
	 * nothing, and a refusal has to say so.
	 */
	async function applyNow(add: string[], remove: string[]): Promise<number> {
		const ops = targets()
			.map((thread) => thread.newest_message)
			.filter((id): id is string => id !== null)
			.map((id) => ({ id, add, remove }));

		if (ops.length === 0) return 0;
		try {
			await api.tag(ops);
			setVisualAnchor(null);
			bumpRevision();
			return ops.length;
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "tagging failed");
			return 0;
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
		return effectiveFormat(
			formatOverride[id],
			settings().preferences.preferHtml,
		);
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

	/**
	 * Walks the open conversation. The message walked to is expanded: a cursor
	 * moving over collapsed headers is indistinguishable from a key that does
	 * nothing, which is how these chords read before.
	 */
	function focusMessage(delta: number) {
		const messages = thread()?.messages ?? [];
		if (messages.length === 0) {
			const row = current();
			if (row) {
				setOpenThread(row.id);
				setMessageIndex(0);
			}
			return;
		}

		const next = Math.min(
			Math.max(messageIndex() + delta, 0),
			messages.length - 1,
		);
		const message = messages[next];
		batch(() => {
			setMessageIndex(next);
			if (message) setCollapsed(message.id, false);
		});
	}

	function messageOpen(id: string, newest: boolean): boolean {
		return isMessageOpen(
			collapsed[id],
			newest,
			settings().preferences.expandNewest,
		);
	}

	function toggleCollapsed(id: string, newest: boolean) {
		setCollapsed(id, messageOpen(id, newest));
	}

	function setAllCollapsed(ids: string[], value: boolean) {
		batch(() => {
			for (const id of ids) setCollapsed(id, value);
		});
	}

	/**
	 * Switching account is the same act as activating its row in the sidebar:
	 * the account expands, its cursor moves there, and its inbox is what loads.
	 * Selecting a bare `tag:<account>` instead left the sidebar collapsed and
	 * matched none of its rows.
	 */
	function cycleAccount(delta: number) {
		const list = accounts() ?? [];
		if (list.length === 0) return;

		const at = list.findIndex((a) => a.id === currentAccount());
		const next = list[(at + delta + list.length * 2) % list.length];
		if (!next) return;

		setExpandedGroup(next.id);
		const group = tree().find((g) => g.account === next.id);
		selectQuery(group?.views[0]?.query ?? `tag:${next.id}`);

		const row = sidebarRows().findIndex(
			(r) => r.kind === "group" && r.group === next.id,
		);
		if (row >= 0) setSidebarIndex(row);

		setStatus(`account ${next.id}`);
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
		themeList,
		setTheme,
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
		viewing,
		setViewing,
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
		focusMessage,
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
		stageTags,
		executeMarks,
		picked,
		visualAnchor,
		selectionIndices,
		isSelected,
		toggleSelect,
		startVisual,
		clearVisual,
		clearSelection,
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
		messageOpen,
		toggleCollapsed,
		setAllCollapsed,
		cycleAccount,
		subscribe,
	};
}

export type AppStore = ReturnType<typeof createAppStore>;
