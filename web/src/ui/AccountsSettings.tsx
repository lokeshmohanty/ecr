import { For, Show, createResource, createSignal, type JSX } from "solid-js";
import type { AppStore } from "../state/store";
import type {
	ManagedAccount,
	ManagedProvider,
	ManagedRule,
	ManagedView,
} from "../api/types";

/**
 * The accounts ecr manages, and the switch that decides whether it manages
 * anything at all.
 *
 * Three states, and the pane has to be honest about which one it is in: ecr
 * manages nothing (the ordinary state of an install that reads a setup somebody
 * else configured), ecr manages the files but has no accounts yet, or ecr has
 * accounts. Only the last one looks like an accounts page, and pretending the
 * first two are a loading state is how a settings pane ends up lying.
 */
const PROVIDERS: { id: ManagedProvider; label: string; note: string }[] = [
	{ id: "gmail", label: "Gmail", note: "OAuth, and All Mail is left unsynced" },
	{
		id: "outlook",
		label: "Outlook",
		note: "OAuth, Microsoft 365 or outlook.com",
	},
	{ id: "fastmail", label: "Fastmail", note: "needs an app password" },
	{ id: "generic", label: "Other IMAP", note: "give the servers yourself" },
];

const PACKAGES = ["notmuch", "mbsync", "msmtp"] as const;

export function AccountsSettings(props: { store: AppStore }) {
	const [view, { refetch }] = createResource<ManagedView | null>(async () => {
		try {
			return await props.store.api.managed();
		} catch {
			// Every other resource in this client answers empty on a failure rather
			// than throwing at whoever reads it, because a resource that lets one out
			// takes the whole pane down with it.
			return null;
		}
	});

	const [adding, setAdding] = createSignal(false);
	const [busy, setBusy] = createSignal(false);

	const managing = () => view()?.managing ?? [];
	const accounts = () => Object.entries(view()?.accounts.account ?? {});

	const run = async (what: string, action: () => Promise<ManagedView>) => {
		setBusy(true);
		try {
			await action();
			props.store.setStatus(what);
			// A managed route edits the settings file on the server, so the local
			// copy the Packages tab reads is stale until this refetches it.
			await Promise.all([refetch(), props.store.refetchSettings()]);
		} catch (error) {
			props.store.setSettingsProblem(
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div class="space-y-6 p-4 text-sm">
			<section class="space-y-2">
				<h2 class="text-xs uppercase tracking-wide text-ink-3">
					Who writes the configuration
				</h2>
				<p class="text-xs text-ink-2">
					Self-managed means you keep notmuch, mbsync and msmtp configured and
					ecr reads them. ecr-managed means ecr generates those files from the
					accounts below, into its own directory — your own files stay where
					they are, and are what it goes back to.
				</p>
				<div class="flex flex-wrap gap-2">
					<For each={PACKAGES}>
						{(pkg) => {
							const on = () => managing().includes(pkg);
							return (
								<button
									type="button"
									disabled={busy()}
									class="touch-target rounded border px-3 py-1 text-xs"
									classList={{
										"border-obligation bg-obligation text-paper": on(),
										"border-rule text-ink-2 hover:bg-neutral-bg": !on(),
									}}
									onClick={() =>
										run(
											on() ? `${pkg} is yours again` : `ecr now manages ${pkg}`,
											() =>
												props.store.api.setManagement(
													pkg,
													on() ? "self" : "ecr",
												),
										)
									}
								>
									{pkg}
								</button>
							);
						}}
					</For>
				</div>
			</section>

			<Show when={view()?.problems.length}>
				<ul class="space-y-1 rounded border border-obligation px-3 py-2 text-xs text-ink">
					<For each={view()?.problems}>{(problem) => <li>{problem}</li>}</For>
				</ul>
			</Show>

			<section class="space-y-2">
				<div class="flex items-center justify-between">
					<h2 class="text-xs uppercase tracking-wide text-ink-3">Accounts</h2>
					<button
						type="button"
						class="touch-target rounded border border-rule px-2 py-1 text-xs text-ink-2 hover:bg-neutral-bg"
						onClick={() => setAdding((was) => !was)}
					>
						{adding() ? "cancel" : "add an account"}
					</button>
				</div>

				<Show
					when={accounts().length > 0}
					fallback={
						<p class="text-xs text-ink-3">
							No accounts here yet.{" "}
							<Show when={managing().length === 0}>
								ecr is reading a setup you configured, which is a perfectly good
								way to run it.
							</Show>
						</p>
					}
				>
					<ul class="divide-y divide-rule">
						<For each={accounts()}>
							{([id, account]) => (
								<AccountRow
									id={id}
									account={account}
									busy={busy()}
									onRemove={() =>
										run(`removed ${id}; its mail is untouched`, () =>
											props.store.api.removeManagedAccount(id),
										)
									}
								/>
							)}
						</For>
					</ul>
				</Show>

				<Show when={adding()}>
					<AddAccount
						busy={busy()}
						onAdd={async (id, account) => {
							await run(`added ${id}`, () =>
								props.store.api.addManagedAccount(id, account),
							);
							setAdding(false);
						}}
					/>
				</Show>
			</section>

			<RulesSection
				rules={view()?.accounts.rule ?? []}
				busy={busy()}
				onSave={(rules) =>
					run("rules saved", () => props.store.api.setRules(rules))
				}
			/>

			<Show when={(view()?.files.length ?? 0) > 0}>
				<section class="space-y-2">
					<h2 class="text-xs uppercase tracking-wide text-ink-3">
						Generated files
					</h2>
					<ul class="space-y-1 font-mono text-xs">
						<For each={view()?.files}>
							{(file) => (
								<li class="flex gap-2">
									<span
										class="w-16 shrink-0"
										classList={{
											"text-ink-3": file.state === "current",
											"text-obligation":
												file.state !== "current" && file.state !== "edited",
											"text-ink": file.state === "edited",
										}}
									>
										{file.state}
									</span>
									<span class="min-w-0 break-all text-ink-2">{file.path}</span>
								</li>
							)}
						</For>
					</ul>
					<Show when={view()?.files.some((f) => f.state !== "current")}>
						<button
							type="button"
							disabled={busy()}
							class="touch-target rounded border border-rule px-2 py-1 text-xs text-ink-2 hover:bg-neutral-bg"
							onClick={() =>
								run("configuration regenerated", () =>
									props.store.api.applyManaged(),
								)
							}
						>
							regenerate them
						</button>
					</Show>
				</section>
			</Show>
		</div>
	);
}

function AccountRow(props: {
	id: string;
	account: ManagedAccount;
	busy: boolean;
	onRemove: () => void;
}) {
	return (
		<li class="flex items-start gap-3 py-2">
			<div class="min-w-0 flex-1">
				<div class="flex items-baseline gap-2">
					<span class="text-ink">{props.id}</span>
					<Show when={props.account.primary}>
						<span class="text-xs text-ink-3">primary</span>
					</Show>
					<Show when={!props.account.enabled}>
						<span class="text-xs text-ink-3">disabled</span>
					</Show>
				</div>
				<div class="truncate text-xs text-ink-2">{props.account.address}</div>
				<div class="text-xs text-ink-3">
					{props.account.provider}
					{" · "}
					{props.account.auth.kind === "oauth"
						? `oauth ${props.account.auth.profile}`
						: // A password command is set at a terminal and shown here only so
							// the reader knows why there is nothing to edit.
							"password command (set at a terminal)"}
				</div>
			</div>
			<button
				type="button"
				disabled={props.busy}
				class="touch-target shrink-0 rounded border border-rule px-2 py-1 text-xs text-ink-2 hover:bg-neutral-bg"
				onClick={props.onRemove}
			>
				remove
			</button>
		</li>
	);
}

function AddAccount(props: {
	busy: boolean;
	onAdd: (id: string, account: ManagedAccount) => void;
}) {
	const [id, setId] = createSignal("");
	const [address, setAddress] = createSignal("");
	const [name, setName] = createSignal("");
	const [provider, setProvider] = createSignal<ManagedProvider>("gmail");
	const [imap, setImap] = createSignal("");
	const [smtp, setSmtp] = createSignal("");

	const generic = () => provider() === "generic";

	const endpoint = (value: string, port: number) => {
		const [host, given] = value.split(":");
		if (!host) return undefined;
		return {
			host,
			port: given ? Number(given) : port,
			tls: (port === 587 ? "starttls" : "implicit") as "starttls" | "implicit",
		};
	};

	const submit = (event: Event) => {
		event.preventDefault();
		props.onAdd(id().trim(), {
			address: address().trim(),
			name: name().trim() || undefined,
			provider: provider(),
			// OAuth named after the account, which is what `ecr oauth setup` would
			// create. A password command cannot be set from here at all: the server
			// refuses one over HTTP, because it is a command it would run.
			auth: { kind: "oauth", profile: id().trim() },
			imap: generic() ? endpoint(imap(), 993) : undefined,
			smtp: generic() ? endpoint(smtp(), 587) : undefined,
			create: "near",
			expunge: "none",
			remove: "none",
			primary: false,
			enabled: true,
		});
	};

	return (
		<form class="space-y-3 rounded border border-rule p-3" onSubmit={submit}>
			<Field
				label="Name for it"
				hint="the folder under your maildir, and its tag"
			>
				<input
					class="w-full rounded border border-rule bg-paper px-2 py-1 text-sm"
					value={id()}
					onInput={(e) => setId(e.currentTarget.value)}
					placeholder="personal"
				/>
			</Field>

			<Field label="Address">
				<input
					class="w-full rounded border border-rule bg-paper px-2 py-1 text-sm"
					value={address()}
					onInput={(e) => setAddress(e.currentTarget.value)}
					placeholder="you@example.com"
				/>
			</Field>

			<Field label="Your name" hint="what goes on the From: line">
				<input
					class="w-full rounded border border-rule bg-paper px-2 py-1 text-sm"
					value={name()}
					onInput={(e) => setName(e.currentTarget.value)}
				/>
			</Field>

			<Field label="Provider">
				<div class="flex flex-wrap gap-2">
					<For each={PROVIDERS}>
						{(option) => (
							<button
								type="button"
								class="touch-target rounded border px-2 py-1 text-xs"
								classList={{
									"border-obligation bg-obligation text-paper":
										provider() === option.id,
									"border-rule text-ink-2 hover:bg-neutral-bg":
										provider() !== option.id,
								}}
								onClick={() => setProvider(option.id)}
								title={option.note}
							>
								{option.label}
							</button>
						)}
					</For>
				</div>
			</Field>

			<Show when={generic()}>
				<Field label="IMAP" hint="host, or host:port">
					<input
						class="w-full rounded border border-rule bg-paper px-2 py-1 text-sm"
						value={imap()}
						onInput={(e) => setImap(e.currentTarget.value)}
						placeholder="imap.example.com"
					/>
				</Field>
				<Field label="SMTP" hint="host, or host:port">
					<input
						class="w-full rounded border border-rule bg-paper px-2 py-1 text-sm"
						value={smtp()}
						onInput={(e) => setSmtp(e.currentTarget.value)}
						placeholder="smtp.example.com"
					/>
				</Field>
			</Show>

			<p class="text-xs text-ink-3">
				Gmail and Outlook need an OAuth token, which is granted at a terminal
				with <code>ecr oauth setup {id() || "&lt;name&gt;"}</code>. Adding the
				account here writes the configuration for it.
			</p>

			<button
				type="submit"
				disabled={props.busy || !id().trim() || !address().trim()}
				class="touch-target rounded border border-obligation bg-obligation px-3 py-1 text-xs text-paper disabled:opacity-50"
			>
				add it
			</button>
		</form>
	);
}

function Field(props: { label: string; hint?: string; children: JSX.Element }) {
	return (
		<label class="block space-y-1">
			<span class="text-xs uppercase tracking-wide text-ink-3">
				{props.label}
			</span>
			<Show when={props.hint}>
				<span class="block text-xs text-ink-3">{props.hint}</span>
			</Show>
			{props.children}
		</label>
	);
}

/**
 * Tagging rules, in the order they run.
 *
 * Order is part of what a rule set means — they run top to bottom, and one that
 * files a message stops a later one seeing it — so the whole set is saved at
 * once and moving a rule is an ordinary edit rather than something the API
 * cannot express.
 */
function RulesSection(props: {
	rules: ManagedRule[];
	busy: boolean;
	onSave: (rules: ManagedRule[]) => void;
}) {
	const [draft, setDraft] = createSignal<ManagedRule[] | null>(null);
	const rules = () => draft() ?? props.rules;
	const dirty = () => draft() !== null;

	const edit = (index: number, patch: Partial<ManagedRule>) => {
		const next = rules().map((rule, at) =>
			at === index ? { ...rule, ...patch } : rule,
		);
		setDraft(next);
	};

	const move = (index: number, delta: number) => {
		const next = [...rules()];
		const to = index + delta;
		if (to < 0 || to >= next.length) return;
		[next[index], next[to]] = [next[to]!, next[index]!];
		setDraft(next);
	};

	return (
		<section class="space-y-2">
			<div class="flex items-center justify-between">
				<h2 class="text-xs uppercase tracking-wide text-ink-3">Rules</h2>
				<button
					type="button"
					class="touch-target rounded border border-rule px-2 py-1 text-xs text-ink-2 hover:bg-neutral-bg"
					onClick={() =>
						setDraft([
							...rules(),
							{
								name: "",
								query: "",
								add: [],
								remove: [],
								keep_in_inbox: false,
							},
						])
					}
				>
					add a rule
				</button>
			</div>
			<p class="text-xs text-ink-2">
				Applied to new mail, top to bottom. Each is a notmuch query — it only
				ever sees mail that has just arrived, so a rule cannot retag the
				database by accident.
			</p>

			<Show
				when={rules().length > 0}
				fallback={<p class="text-xs text-ink-3">No rules.</p>}
			>
				<ul class="space-y-2">
					<For each={rules()}>
						{(rule, index) => (
							<li class="space-y-1 rounded border border-rule p-2">
								<div class="flex gap-2">
									<input
										class="min-w-0 flex-1 rounded border border-rule bg-paper px-2 py-1 text-xs"
										placeholder="what it is for"
										value={rule.name ?? ""}
										onInput={(e) =>
											edit(index(), { name: e.currentTarget.value })
										}
									/>
									<button
										type="button"
										class="touch-target rounded border border-rule px-2 text-xs text-ink-3"
										title="move up"
										onClick={() => move(index(), -1)}
									>
										↑
									</button>
									<button
										type="button"
										class="touch-target rounded border border-rule px-2 text-xs text-ink-3"
										title="move down"
										onClick={() => move(index(), 1)}
									>
										↓
									</button>
									<button
										type="button"
										class="touch-target rounded border border-rule px-2 text-xs text-ink-3"
										title="remove"
										onClick={() =>
											setDraft(rules().filter((_, at) => at !== index()))
										}
									>
										✕
									</button>
								</div>
								<input
									class="mono w-full rounded border border-rule bg-paper px-2 py-1 text-xs"
									placeholder="from:news@example.com"
									value={rule.query}
									onInput={(e) =>
										edit(index(), { query: e.currentTarget.value })
									}
								/>
								<div class="flex flex-wrap gap-2">
									<input
										class="mono min-w-0 flex-1 rounded border border-rule bg-paper px-2 py-1 text-xs"
										placeholder="tags to add, space separated"
										value={rule.add.join(" ")}
										onInput={(e) =>
											edit(index(), {
												add: e.currentTarget.value.split(/\s+/).filter(Boolean),
											})
										}
									/>
									<label class="flex items-center gap-1 text-xs text-ink-2">
										<input
											type="checkbox"
											checked={rule.keep_in_inbox}
											onChange={(e) =>
												edit(index(), {
													keep_in_inbox: e.currentTarget.checked,
												})
											}
										/>
										keep in inbox
									</label>
								</div>
							</li>
						)}
					</For>
				</ul>
			</Show>

			<Show when={dirty()}>
				<div class="flex gap-2">
					<button
						type="button"
						disabled={props.busy}
						class="touch-target rounded border border-obligation bg-obligation px-3 py-1 text-xs text-paper"
						onClick={() => {
							props.onSave(rules());
							setDraft(null);
						}}
					>
						save rules
					</button>
					<button
						type="button"
						class="touch-target rounded border border-rule px-3 py-1 text-xs text-ink-2"
						onClick={() => setDraft(null)}
					>
						discard
					</button>
				</div>
			</Show>
		</section>
	);
}
