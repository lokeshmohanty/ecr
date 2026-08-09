import { For, Show, createResource, createSignal } from "solid-js";
import type { AppStore } from "../../../state/store";
import type { ManagedAccount, ManagedView } from "../../../api/types";
import { openExternal } from "../../../api/platform";
import { Action } from "../fields";
import { AccountForm } from "./AccountForm";
import { AccountRow } from "./AccountRow";
import { RulesSection } from "./RulesSection";

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
const PACKAGES = ["notmuch", "mbsync", "msmtp"] as const;

type Editing = { id: string; account: ManagedAccount } | "new" | null;

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

	const [editing, setEditing] = createSignal<Editing>(null);
	const [busy, setBusy] = createSignal(false);
	/** The consent still waiting to be clicked through, if any. */
	const [pending, setPending] = createSignal<{ id: string; url: string } | null>(
		null,
	);

	const managing = () => view()?.managing ?? [];
	const accounts = () => Object.entries(view()?.accounts.account ?? {});
	const local = () => view()?.local ?? false;

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

	/**
	 * Starting a flow is not finishing one. The server answers as soon as there
	 * is a URL to open — the consent screen is minutes of a person — so this
	 * opens it and refetches, and the row's token state is what says whether it
	 * worked. Reporting "authorized" here would be reporting that a browser
	 * opened.
	 */
	const authorize = async (id: string, withDav: boolean) => {
		setBusy(true);
		try {
			const started = await props.store.api.authorizeAccount(id, withDav);
			// The *server* opens the browser, and it is on this machine — that is
			// the rule these buttons exist under. Opening it here as well would be
			// a second tab for the same consent, and in a plain browser it is the
			// call a popup blocker stops anyway, being no longer inside the click.
			// The URL is shown instead, for a server running where no browser is.
			setPending({ id, url: started.url });
			props.store.setStatus(
				withDav && started.widened
					? `${id}: approve contacts and calendars in the browser`
					: `${id}: approve it in the browser`,
			);
		} catch (error) {
			props.store.setSettingsProblem(
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div class="scroll-y flex-1 space-y-6 p-4 text-sm">
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
												props.store.api.setManagement(pkg, on() ? "self" : "ecr"),
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

			{/*
        A flow that has been started but not finished. The token state on the
        row is what says whether it worked — this is only here so a server with
        no browser to open still has something to act on, and so the reader can
        tell an authorization they abandoned from one that never began.
      */}
			<Show when={pending()}>
				{(waiting) => (
					<div class="space-y-1 rounded border border-obligation px-3 py-2 text-xs">
						<p class="text-ink">
							Waiting for {waiting().id} to be approved in the browser.
						</p>
						<p class="text-ink-2">
							If nothing opened, use this address:{" "}
							<button
								type="button"
								class="mono break-all text-left text-obligation underline"
								onClick={() => openExternal(waiting().url)}
							>
								{waiting().url}
							</button>
						</p>
						<div class="flex gap-2 pt-1">
							<Action
								label="check now"
								disabled={busy()}
								onClick={() => {
									void refetch();
									setPending(null);
								}}
							/>
						</div>
					</div>
				)}
			</Show>

			<Show when={view()?.problems.length}>
				<ul class="space-y-1 rounded border border-obligation px-3 py-2 text-xs text-ink">
					<For each={view()?.problems}>{(problem) => <li>{problem}</li>}</For>
				</ul>
			</Show>

			<section class="space-y-2">
				<div class="flex items-center justify-between">
					<h2 class="text-xs uppercase tracking-wide text-ink-3">Accounts</h2>
					<Action
						label={editing() === "new" ? "cancel" : "add an account"}
						onClick={() => setEditing(editing() === "new" ? null : "new")}
					/>
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
									auth={view()?.auth?.[id]}
									local={local()}
									busy={busy()}
									onEdit={() => setEditing({ id, account })}
									onRemove={() =>
										run(`removed ${id}; its mail is untouched`, () =>
											props.store.api.removeManagedAccount(id),
										)
									}
									onAuthorize={(withDav) => authorize(id, withDav)}
								/>
							)}
						</For>
					</ul>
				</Show>

				{/*
          `keyed`, so switching from adding to editing — or from one account to
          another — builds a new form rather than leaving the old one's field
          values in place. The signals inside it are initialised from `existing`
          exactly once, which is the whole reason this has to be re-created.
        */}
				<Show when={editing()} keyed>
					{(current) => {
						const existing = current === "new" ? undefined : current;
						return (
							<AccountForm
								busy={busy()}
								existing={existing}
								onCancel={() => setEditing(null)}
								onSubmit={async (id, account) => {
									await run(existing ? `saved ${id}` : `added ${id}`, () =>
										existing
											? props.store.api.updateManagedAccount(id, account)
											: props.store.api.addManagedAccount(id, account),
									);
									setEditing(null);
								}}
							/>
						);
					}}
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
						<Action
							label="regenerate them"
							disabled={busy()}
							onClick={() =>
								run("configuration regenerated", () =>
									props.store.api.applyManaged(),
								)
							}
						/>
					</Show>
				</section>
			</Show>
		</div>
	);
}
