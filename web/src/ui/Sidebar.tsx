import { For, Show, createEffect } from "solid-js";
import { titleCase, type AppStore, type SidebarRow } from "../state/store";
import { ALL_ACCOUNTS } from "../state/views";
import { isNarrow } from "./narrow";

export function Sidebar(props: {
	store: AppStore;
	onCompose: () => void;
	onSettings: () => void;
}) {
	let scroller: HTMLDivElement | undefined;

	const focused = () => props.store.pane() === "sidebar";
	const rows = () => props.store.sidebarRows();
	const preferences = () => props.store.settings().preferences;

	createEffect(() => {
		const index = props.store.sidebarIndex();
		if (!focused() || !scroller) return;
		scroller
			.querySelector<HTMLElement>(`[data-row="${index}"]`)
			?.scrollIntoView({
				block: "nearest",
			});
	});

	// Asking here rather than in the store keeps the request tied to what is
	// actually rendered: a collapsed section costs nothing.
	createEffect(() => {
		rows();
		props.store.requestVisibleCounts();
	});

	const activate = (index: number) => {
		props.store.setSidebarIndex(index);
		props.store.setPane("sidebar");

		// Same hand-over as Enter: on a phone the sidebar fills the screen, so
		// picking a view has to show the result of picking it.
		if (props.store.activateSidebar() && isNarrow())
			props.store.setPane("list");
	};

	return (
		<nav
			class="pane h-full border-r border-rule bg-paper-2"
			classList={{ "pane-focused": focused() }}
			/*
        On the way *down*, so that a control inside — a view row handing over
        to the list, compose, settings — has the last word. Bubbling up, this
        ran after them and put the pane straight back, which on a desktop
        changes nothing visible and on a phone made every one of them dead.
      */
			oncapture:click={() => props.store.setPane("sidebar")}
		>
			<div ref={scroller} class="scroll-y flex-1 px-2 py-2">
				<For each={rows()}>
					{(row, index) => (
						<Row
							row={row}
							index={index()}
							store={props.store}
							cursor={focused() && props.store.sidebarIndex() === index()}
							icons={preferences().sidebarIcons}
							leaders={preferences().sidebarLeaders}
							onActivate={() => activate(index())}
						/>
					)}
				</For>

				{/* A row that cannot work is worth saying out loud: without the index
            setting a List: query silently matches nothing. */}
				<Show
					when={
						!props.store.listsSearchable() &&
						preferences().sidebarSections.includes("lists")
					}
				>
					<p class="mt-2 px-2 text-[11px] leading-snug text-ink-3">
						Mailing lists need <span class="mono">index.header.List</span> in
						your notmuch config, then{" "}
						<span class="mono">notmuch reindex '*'</span>. Run{" "}
						<span class="mono">ecr doctor</span>.
					</p>
				</Show>
			</div>

			<div class="shrink-0 space-y-2 border-t border-rule p-2">
				<button
					type="button"
					class="touch-target w-full rounded bg-obligation px-3 py-2 font-semibold text-paper hover:opacity-90"
					onClick={props.onCompose}
				>
					Compose
				</button>
				<button
					type="button"
					class="touch-target flex w-full items-center justify-center gap-2 rounded border border-rule px-3 py-1.5 text-ink-2 hover:bg-neutral-bg"
					onClick={props.onSettings}
					title="Settings (,)"
				>
					⚙ Settings
				</button>
			</div>
		</nav>
	);
}

function Row(props: {
	row: SidebarRow;
	index: number;
	store: AppStore;
	cursor: boolean;
	icons: boolean;
	leaders: boolean;
	onActivate: () => void;
}) {
	const row = () => props.row;
	const active = () =>
		row().kind === "view" && props.store.query() === row().query;
	const expandedGroup = () => props.store.expandedGroup() === row().group;
	const expandedSection = () =>
		!!row().section &&
		props.store.expandedSections().has(`${row().group}:${row().section}`);
	const open = () =>
		row().kind === "group" ? expandedGroup() : expandedSection();
	const count = () =>
		row().counted ? props.store.countOf(row().query) : undefined;

	const label = () =>
		row().kind === "group" && row().name === ALL_ACCOUNTS
			? "All Accounts"
			: row().kind === "group"
				? titleCase(row().name)
				: row().name;

	const foldable = () => row().kind === "group" || row().kind === "section";

	return (
		<button
			type="button"
			data-row={props.index}
			data-kind={row().kind}
			class="flex w-full items-baseline gap-2 rounded py-1 pr-2 text-left"
			classList={{
				"mt-2 first:mt-0 tracking-widest": row().kind === "group",
				"mt-1 tracking-wide": row().kind === "section",
				"text-xs tracking-wide": row().kind === "view",
				"pl-1": row().indent === 0,
				"pl-3": row().indent === 1,
				"pl-6": row().indent === 2,
				"bg-obligation-bg text-ink": active(),
				"text-ink": !active() && foldable() && open(),
				"text-ink-3 hover:bg-neutral-bg": !active() && foldable() && !open(),
				"text-ink-2 hover:bg-neutral-bg": !active() && !foldable(),
				"ring-1 ring-obligation": props.cursor,
			}}
			aria-expanded={foldable() ? open() : undefined}
			onClick={props.onActivate}
		>
			<Show when={foldable()}>
				<span class="shrink-0 text-ink-3">{open() ? "▾" : "▸"}</span>
			</Show>

			<Show when={props.icons && row().icon !== ""}>
				<span class="shrink-0 text-ink-3">{row().icon}</span>
			</Show>

			<span class="truncate-cell shrink-0 max-w-full">{label()}</span>

			{/*
        The leader is a border on an empty flexible span rather than a run of
        dots, so it stretches to whatever is left and never wraps or rounds to a
        different number of characters at a different width.
      */}
			<Show when={props.leaders && count() !== undefined}>
				<span class="min-w-2 flex-1 translate-y-[-0.28em] border-b border-dotted border-rule" />
			</Show>
			<Show when={!props.leaders || count() === undefined}>
				<span class="flex-1" />
			</Show>

			<Show when={count() !== undefined}>
				<span class="mono shrink-0 text-[11px] text-ink-3">{count()}</span>
			</Show>
		</button>
	);
}
