import {
	createEffect,
	batch,
	createMemo,
	createResource,
	createSignal,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
	Api,
	loadConnection,
	saveConnection,
	type Connection,
} from "../api/client";
import { notify, shellServerUrl } from "../api/platform";
import type { Account, Draft, ServerEvent, ThreadSummary } from "../api/types";
import type { Mode, Pane } from "../keymap/engine";
import {
	fromToml,
	loadSettings,
	withClient,
	preferencesInScope,
	loadSettingsText,
	saveSettings,
	toToml,
	type Settings,
} from "./settings";
import { applyTheme, loadThemeText, parseTheme, saveThemeText } from "./theme";
import { createCounts } from "./counts";
import {
	ALL_ACCOUNTS,
	SECTION_LABELS,
	accountLabel,
	buildTree,
	scopeQuery,
	type CustomView,
	type SectionId,
	type ViewGroup,
} from "./views";
import { parseAddress, type AddressEntry } from "./suggest";
import { effectiveFormat, toggled, type MessageFormat } from "./format";

import {
	MARK_TAGS,
	badgesFor,
	emptyStaged,
	markToOps,
	parseTagInput,
	type Mark,
	type MarkQueue,
	type Staged,
} from "./store/marks";
import {
	sectionKey,
	quoteTerm,
	tagsWithoutAccounts,
	titleCase,
	type SidebarRow,
} from "./store/sidebar";

// Re-exported so every existing `from "../state/store"` import keeps working.
export {
	MARK_TAGS,
	badgesFor,
	emptyStaged,
	markToOps,
	parseTagInput,
	sectionKey,
	titleCase,
	type Mark,
	type MarkQueue,
	type SidebarRow,
	type Staged,
};

export type RightPane =
	| { kind: "reading" }
	| { kind: "compose"; draft: Draft; label: string }
	| { kind: "settings" };

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
	{ name: "Inbox", query: "tag:inbox" },
	{ name: "Unread", query: "tag:unread" },
	{ name: "Flagged", query: "tag:flagged" },
	{ name: "Today", query: "date:today" },
	{ name: "Sent", query: "tag:sent" },
	{ name: "Drafts", query: "tag:draft" },
	{ name: "Archive", query: "not tag:inbox and not tag:trash" },
	{ name: "All", query: "*" },
];

/** A row kept in the list, and the position it was read at. */
export interface HeldRow {
	index: number;
	row: ThreadSummary;
}

export interface HeldRows {
	query: string;
	rows: HeldRow[];
}

/**
 * Puts the held rows back into a page that no longer carries them, at the
 * index each was last seen at. A row the query matches again is left alone —
 * the server's copy is the current one.
 */
export function mergeHeld(
	fetched: ThreadSummary[],
	rows: HeldRow[],
): ThreadSummary[] {
	if (rows.length === 0) return fetched;

	const present = new Set(fetched.map((thread) => thread.id));
	const merged = [...fetched];
	for (const { index, row } of rows) {
		if (present.has(row.id)) continue;
		merged.splice(Math.min(index, merged.length), 0, row);
	}
	return merged;
}

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
	// The list pane keys on this, not `revision`: a tag change (marking a
	// message read, or a `tags_changed` SSE from another client) bumps
	// `revision` only, so the sidebar counts and the open thread refresh but
	// the list is not re-fetched and reshuffled. New mail and user actions
	// bump both, so the list reflects them.
	const [listRevision, setListRevision] = createSignal(0);
	/**
	 * Rows the list goes on showing after they stopped matching its query.
	 * Reading a message drops `unread`, which takes it straight out of
	 * `tag:unread` — the row would disappear from under the cursor as a
	 * side-effect of looking at it. The query is held with the rows, so moving
	 * to another view drops them; a sync or writing staged tags clears them
	 * outright. Nothing here changes what the server matched: the rows are put
	 * back where they were, on top of the page that no longer carries them.
	 */
	const [held, setHeld] = createSignal<HeldRows>({ query: "", rows: [] });
	const [mode, setMode] = createSignal<Mode>("normal");
	const [pane, setPaneSignal] = createSignal<Pane>("list");
	/**
	 * Fullscreen zooms the detail pane to the whole window, hiding the sidebar
	 * and the list. It is cleared the moment focus leaves the detail pane, so
	 * `h`/`l` back out of it rather than landing on a pane you cannot see.
	 */
	const [fullscreen, setFullscreen] = createSignal(false);
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
	/**
	 * Touch has no Space, and a phone has no room for a cursor you can see. So
	 * picking rows is a mode you enter — by long-pressing a row, or from the
	 * action bar — and while it is on, a tap picks instead of opening.
	 */
	const [selectionMode, setSelectionModeSignal] = createSignal(false);
	/** Where a v/V range started, or null when no range is being drawn. */
	const [visualAnchor, setVisualAnchor] = createSignal<number | null>(null);
	const [connected, setConnected] = createSignal(false);
	const [lastError, setLastError] = createSignal("");
	/** Survives a healthy connection: only editing the file clears it. */
	const [settingsProblem, setSettingsProblem] = createSignal("");
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
	const [expandedSections, setExpandedSections] = createSignal<
		ReadonlySet<string>
	>(new Set<string>());
	// A signal holding an immutable record rather than a store: counts arrive for
	// keys that were not there when the sidebar first read them, and replacing
	// the whole record is what reliably wakes those readers.
	const [countMap, setCountMap] = createSignal<Record<string, number>>({});
	/** True once the server's settings have been read, or failed to be. */
	const [configSettled, setConfigSettled] = createSignal(false);

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
		() => [query(), listRevision(), connection().baseUrl] as const,
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

	/**
	 * A bad line in settings.toml is not a connection failure, and must not be
	 * cleared like one: `lastError` is wiped the moment the server answers, and
	 * it is only painted where the thread list would be. With mail on screen a
	 * bad line would otherwise vanish in silence — the one thing this file's
	 * design promises not to do.
	 */
	function reportSettingsProblem(message: string) {
		setSettingsProblem(message);
	}

	/** Applies edited text, or reports why it cannot. */
	function applySettingsText(text: string): string[] {
		const { settings: parsed, errors } = fromToml(text);
		if (errors.length === 0) {
			// The edited text is the shared half only, so anything this device
			// owns has to survive the edit rather than fall back to a default
			// the file no longer carries.
			setSettings(
				{
					...parsed,
					preferences: {
						...parsed.preferences,
						...preferencesInScope(settings().preferences, "client"),
					},
					bindings: settings().bindings,
				},
				text,
			);
			setSettingsProblem("");
		}
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
				// The file is the shared half. This device's own half goes back
				// over it, or the server would hand every client one theme.
				const { settings: fromFile, errors } = fromToml(file.raw);
				const parsed = withClient(fromFile);
				saveSettings(parsed, file.raw);
				setSettingsSignal(parsed);
				setSettingsSource(file.raw);
				setAllowRemote(parsed.preferences.loadRemoteImages);
				// The status bar as well as lastError: lastError is only painted
				// where the thread list would be, so with mail on screen a bad
				// line in settings.toml would otherwise be discarded in silence —
				// the one thing this file's design promises not to do.
				if (errors.length > 0)
					reportSettingsProblem(`${file.path}: ${errors[0]}`);
			} catch {
				// Offline, or an old server: the local copy stands.
			} finally {
				setConfigSettled(true);
			}
		})();
	});

	// Tailwind compiles every utility to var(--color-*), so writing the theme's
	// values onto the root element restyles the app without a component knowing
	// a theme exists. The cached copy is applied first so startup does not paint
	// the built-in palette and then flip to the chosen one.
	createEffect(() => {
		const cached = loadThemeText();
		if (cached !== "")
			applyTheme(parseTheme(cached).theme, document.documentElement);
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

	// Gathered from the database rather than configured. Each is fetched once per
	// connection and refreshed on a revision bump, since new mail can introduce a
	// tag, a correspondent or a list that was not there before.
	const gathered = () =>
		connection().baseUrl ? `${connection().baseUrl}|${revision()}` : null;

	const [tagList] = createResource(gathered, async () => {
		const tags = await api.tags();
		return [...tags].sort((a, b) => a.localeCompare(b));
	});

	const sidebarTags = () =>
		tagsWithoutAccounts(tagList() ?? [], accounts() ?? []);

	const [listInfo] = createResource(gathered, async () => await api.lists());
	const listList = () => listInfo()?.lists;

	const counts = createCounts(
		api,
		(entries) =>
			setCountMap((current) => ({
				...current,
				...Object.fromEntries(entries),
			})),
		(query) => countMap()[query],
		() => setCountMap({}),
		{ onError: () => {} },
	);

	const [themeList] = createResource(
		() => connection().baseUrl || null,
		async () => (await api.themes()).presets,
	);

	/**
	 * Writes the one line, so picking a theme on this page never costs the user
	 * the comments they wrote around it. The effect above does the applying.
	 */
	/**
	 * The theme belongs to the device, not to the shared file, so it is set
	 * directly rather than by editing the file's text: that path preserves the
	 * device's half against the edit, which would discard the very change being
	 * made.
	 */
	function setTheme(path: string) {
		const current = settings();
		setSettings({
			...current,
			preferences: { ...current.preferences, theme: path },
		});
	}

	/** Same reason as the theme: client-scoped, so it is set, never written as text. */
	function setCustomQueries(rows: CustomView[]) {
		const current = settings();
		setSettings({
			...current,
			preferences: { ...current.preferences, sidebarCustom: rows },
		});
	}

	/**
	 * Saves whatever the list is showing as a row of its own. The query is stored
	 * as it stands, including any account it was already narrowed to — a row that
	 * silently widened to every account would not be the thing that was saved.
	 */
	function saveQuery(name: string) {
		const label = name.trim();
		if (label === "") {
			setStatus("usage: :save <name>");
			return;
		}

		const rows = settings().preferences.sidebarCustom;
		const row: CustomView = { name: label, query: query(), icon: "◆" };
		const at = rows.findIndex((r) => r.name === label);

		setCustomQueries(at === -1 ? [...rows, row] : rows.with(at, row));
		setExpandedSections((open) =>
			new Set(open).add(sectionKey(expandedGroup(), "queries")),
		);
		setStatus(`saved ${label}`);
	}

	function bumpRevision() {
		api.invalidate();
		counts.invalidate();
		setRevision((r) => r + 1);
		setListRevision((r) => r + 1);
	}

	/**
	 * A tag change — a `tags_changed` SSE from another client, or the reader
	 * marking a message read once it has been on screen. The sidebar counts,
	 * the open thread and the gathered tags/people/lists refresh, but the list
	 * pane does not: a list being read is not re-fetched and reshuffled because
	 * a message's tags changed. A message physically removed from the maildir
	 * fires `mail_changed`, which goes through `bumpRevision` and does refresh
	 * the list.
	 */
	function bumpForTagChange() {
		api.invalidate();
		counts.invalidate();
		setRevision((r) => r + 1);
	}

	const displayed = createMemo(() => {
		const fetched = threads()?.items ?? [];
		const kept = held();
		return kept.query === query() ? mergeHeld(fetched, kept.rows) : fetched;
	});

	function items(): ThreadSummary[] {
		return displayed();
	}

	/**
	 * Keeps the row a message was read from where it was, tagged as it now is.
	 * The thread stays unread if another of its messages still is.
	 */
	function holdCurrentRow(readMessage: string) {
		const list = items();
		const index = list.findIndex((thread) => thread.id === openThread());
		const row = list[index];
		if (!row) return;

		const kept = held();
		const rows = kept.query === query() ? kept.rows : [];
		if (rows.some((entry) => entry.row.id === row.id)) return;

		const unread = (thread()?.messages ?? []).some(
			(message) => message.id !== readMessage && message.tags.includes("unread"),
		);
		const entry = {
			index,
			row: unread
				? row
				: { ...row, tags: row.tags.filter((tag) => tag !== "unread") },
		};
		setHeld({
			query: query(),
			rows: [...rows, entry].sort((a, b) => a.index - b.index),
		});
	}

	/** Forgets them, so the next list is what the query actually matches now. */
	function releaseHeld() {
		setHeld({ query: "", rows: [] });
	}

	// Leaving a view drops what it was holding, rather than parking it until the
	// reader comes back to find rows the query stopped matching a session ago.
	createEffect(() => {
		query();
		releaseHeld();
	});

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
		const list = displayed();
		if (list.length === 0) return;
		if (!settings().preferences.followSelection) return;
		if (right().kind !== "reading") return;

		const open = openThread();
		if (open && list.some((t) => t.id === open)) return;

		const target = list[selected()] ?? list[0];
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
	/**
	 * The sidebar as one flat, index-addressable list.
	 *
	 * Flat is the contract: j/k walk it by index and Enter activates whatever
	 * `sidebarIndex` lands on, so nesting is expressed by `indent` rather than
	 * by structure. Only the expanded group and its expanded sections
	 * contribute rows, which is also what bounds how many counts are asked for.
	 */
	function sidebarRows(): SidebarRow[] {
		const rows: SidebarRow[] = [];
		const preferences = settings().preferences;
		const sections = preferences.sidebarSections;

		for (const group of tree()) {
			rows.push({
				kind: "group",
				name: group.account,
				group: group.account,
				query: group.views[0]?.query ?? "*",
				icon: "",
				indent: 0,
				counted: false,
			});

			if (expandedGroup() !== group.account) continue;

			for (const section of sections) {
				if (section === "mailboxes") {
					for (const view of group.views) {
						rows.push({
							kind: "view",
							name: view.name,
							group: group.account,
							query: view.query,
							icon: view.icon,
							indent: 1,
							counted: true,
						});
					}
					continue;
				}

				const label = SECTION_LABELS[section];
				const key = sectionKey(group.account, section);
				rows.push({
					kind: "section",
					name: label.title,
					group: group.account,
					query: "",
					icon: label.icon,
					indent: 1,
					counted: false,
					section,
				});

				if (!expandedSections().has(key)) continue;
				for (const entry of sectionEntries(section, group.account)) {
					// The query is already scoped to this account, so a count of zero
					// means the tag or list has no mail here. Undefined means the count
					// has not arrived yet, so the row shows until it does; hiding only
					// confirmed empties keeps "All Accounts" from flashing, since every
					// tag is non-empty under its unscoped query. A saved query is the
					// exception: it was written down on purpose, and a row that
					// disappears the moment it matches nothing reads as the setting
					// having been lost.
					if (section !== "queries" && countOf(entry.query) === 0) continue;
					rows.push({
						kind: "view",
						name: entry.name,
						group: group.account,
						query: entry.query,
						icon: entry.icon,
						indent: 2,
						counted: true,
					});
				}
			}
		}
		return rows;
	}

	/** The rows a gathered section contributes, newest data first. */
	function sectionEntries(
		section: Exclude<SectionId, "mailboxes">,
		account: string,
	): { name: string; query: string; icon: string }[] {
		if (section === "tags") {
			return sidebarTags().map((tag) => ({
				name: tag,
				query: scopeQuery(`tag:${quoteTerm(tag)}`, account),
				icon: "◇",
			}));
		}
		if (section === "queries") {
			return settings().preferences.sidebarCustom.map((custom) => ({
				// A row still being typed on the settings page has no name yet, and a
				// blank line in the sidebar is unreachable rather than merely untidy.
				name: custom.name || custom.query,
				query: scopeQuery(custom.query, account),
				icon: custom.icon || SECTION_LABELS.queries.icon,
			}));
		}
		return (listList() ?? []).map((list) => ({
			name: list.name,
			query: scopeQuery(`List:${quoteTerm(list.id)}`, account),
			icon: "≡",
		}));
	}

	let sidebarFollowTimer: number | undefined;

	function moveSidebar(delta: number) {
		const total = sidebarRows().length;
		if (total === 0) return;
		setSidebarIndex((i) => Math.min(Math.max(i + delta, 0), total - 1));

		// Like the list, the mailbox under the cursor is what the list pane
		// shows, so a burst of j/k lands on one request rather than one per row.
		if (sidebarFollowTimer !== undefined) clearTimeout(sidebarFollowTimer);
		sidebarFollowTimer = window.setTimeout(
			() => followSidebar(sidebarIndex()),
			FOLLOW_DELAY,
		);
	}

	/**
	 * Loads the mailbox under the cursor without leaving the sidebar. Only a
	 * view row changes the list; a group or section header does not, so folding
	 * stays an explicit act. The right pane is left untouched, so a draft or
	 * the settings page is not closed by browsing.
	 */
	function followSidebar(index: number) {
		if (!settings().preferences.followSelection) return;
		const row = sidebarRows()[index];
		if (!row || row.kind !== "view") return;
		batch(() => {
			setQuery(row.query);
			setSelected(0);
			setOpenThread(null);
		});
	}

	/** True when the row changed what is being looked at, rather than folding. */
	function activateSidebar(): boolean {
		const row = sidebarRows()[sidebarIndex()];
		if (!row) return false;

		if (row.kind === "section" && row.section) {
			toggleSection(row.group, row.section);
			return false;
		}
		if (row.kind === "group") {
			setExpandedGroup(row.group);
		}
		selectQuery(row.query);
		return true;
	}

	function toggleSection(group: string, section: SectionId) {
		const key = sectionKey(group, section);
		setExpandedSections((current) => {
			const next = new Set(current);
			if (!next.delete(key)) next.add(key);
			return next;
		});
	}

	/**
	 * Counts for the rows actually on screen, and nothing else.
	 *
	 * Nothing is asked for until the server's settings have landed: until then
	 * `sidebarCounts` is only the built-in default, and someone who turned
	 * counts off would still pay for one request on every cold start.
	 */
	function requestVisibleCounts() {
		if (!configSettled() || !settings().preferences.sidebarCounts) return;
		counts.request(
			sidebarRows()
				.filter((r) => r.counted)
				.map((r) => r.query),
		);
	}

	function countOf(query: string): number | undefined {
		return settings().preferences.sidebarCounts ? counts.get(query) : undefined;
	}

	/**
	 * Opens the composer on a draft. The three steps are one action because a
	 * composer that is not pinned open, or that a phone is not looking at, has
	 * been opened invisibly — which is what happens when a `mailto:` link
	 * arrives from outside the app and the window comes to the front showing
	 * the list.
	 */
	function composeDraft(draft: Draft, label: string) {
		batch(() => {
			setRight({ kind: "compose", draft, label });
			setPinnedOpen(true);
			setPane("detail");
		});
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

	function setPane(next: Pane) {
		if (next !== "detail") setFullscreen(false);
		setPaneSignal(next);
	}

	function focusPane(delta: number) {
		const index = PANES.indexOf(pane());
		const next = PANES[Math.min(Math.max(index + delta, 0), PANES.length - 1)];
		if (next) setPane(next);
	}

	function toggleFullscreen() {
		setFullscreen(!fullscreen());
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

	/** Leaving the mode drops the selection, so nothing acts on rows you cannot see. */
	function setSelectionMode(on: boolean) {
		batch(() => {
			setSelectionModeSignal(on);
			if (!on) {
				setPicked([]);
				setVisualAnchor(null);
			}
		});
	}

	function toggleSelect() {
		const list = items();
		if (list.length === 0) return;

		const anchor = visualAnchor();
		if (anchor !== null) {
			// A range is being drawn: Space toggles every row it covers as
			// one, turning the range into picks (and back), then leaves
			// visual mode. The picks stay behind, so a second key acts on
			// them — Escape with no range on screen clears them.
			const from = Math.min(anchor, selected());
			const to = Math.max(anchor, selected());
			const range: string[] = [];
			for (let i = from; i <= to && i < list.length; i++) {
				const id = list[i]?.id;
				if (id) range.push(id);
			}
			if (range.length === 0) {
				setVisualAnchor(null);
				setStatus("");
				return;
			}

			const existing = new Set(picked());
			const allPicked = range.every((id) => existing.has(id));
			const next = new Set(existing);
			for (const id of range) {
				if (allPicked) next.delete(id);
				else next.add(id);
			}
			setPicked([...next]);
			setVisualAnchor(null);
			setStatus(`${selectionIndices().length} selected`);
			return;
		}

		const thread = current();
		if (!thread) return;

		setPicked((prior) =>
			prior.includes(thread.id)
				? prior.filter((id) => id !== thread.id)
				: [...prior, thread.id],
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
				releaseHeld();
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
			releaseHeld();
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
				holdCurrentRow(id);
				bumpForTagChange();
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

	/**
	 * The last moment mail was announced, so one delivery is not announced
	 * twice.
	 *
	 * A sync writes files into the maildir, which the watcher sees, so
	 * `sync:finished` and `mail:changed` can both describe the same arrival —
	 * the second arriving a beat late, after `syncing` has already gone false
	 * and can no longer suppress it.
	 */
	let announcedAt = 0;

	/**
	 * Nothing here may throw. This runs inside the server-event handler, ahead
	 * of the revision bump that refetches the list, so an exception on the way
	 * to a notification would stop new mail from appearing at all — the failure
	 * being to not show the thing the notification was about.
	 */
	function announceNewMail(text: string) {
		try {
			if (!settings().preferences.notifyNewMail) return;
			// Whoever is looking at the window can already see the list change.
			if (typeof document !== "undefined" && document.hasFocus()) return;

			const now = Date.now();
			if (now - announcedAt < 5000) return;
			announcedAt = now;

			void notify("ecr", text);
		} catch {
			// A notification is the least important thing happening here.
		}
	}

	function onServerEvent(event: ServerEvent) {
		switch (event.type) {
			case "mail_changed":
				// During a sync the count is worth waiting for; `sync:finished`
				// carries it and this event does not.
				if (!syncing()) announceNewMail("New mail");
				bumpRevision();
				break;
			case "tags_changed":
				bumpForTagChange();
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
				if (event.new_messages > 0) {
					announceNewMail(
						event.new_messages === 1
							? "1 new message"
							: `${event.new_messages} new messages`,
					);
				}
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
		saveQuery,
		setCustomQueries,
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
		fullscreen,
		toggleFullscreen,
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
		expandedSections,
		toggleSection,
		requestVisibleCounts,
		countOf,
		tagList,
		listList,
		listsSearchable: () => listInfo()?.searchable ?? true,
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
		settingsProblem,
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
		held,
		releaseHeld,
		current,
		move,
		marks,
		mark,
		stageTags,
		executeMarks,
		picked,
		selectionMode,
		setSelectionMode,
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
		composeDraft,
		subscribe,
	};
}

export type AppStore = ReturnType<typeof createAppStore>;
