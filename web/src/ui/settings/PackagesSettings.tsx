import { For, Show } from "solid-js";
import type { AppStore } from "../../state/store";
import { withValue } from "../../state/settings";
import { PACKAGE_IDS, PACKAGE_LABELS, type PackageId } from "../../state/packages";
import { Choice } from "./fields";

/**
 * Who writes notmuch's, mbsync's and msmtp's configuration.
 *
 * These are `[packages.*]`, which the *server* owns — so they go through
 * `withValue` on the shared file rather than through `setSettings`. That is the
 * opposite of everything on the device page, and getting it the wrong way round
 * is silent in both directions: a client-scoped option routed through
 * `applySettingsText` discards the very change being made.
 */
export function PackagesSettings(props: {
	store: AppStore;
	onShowAccounts: () => void;
}) {
	// Edits the file in place rather than regenerating it, so a switch flipped
	// here never costs the user the comments they wrote.
	const edit = (id: PackageId, key: string, literal: string) => {
		const text = withValue(
			props.store.settingsSource(),
			`[packages.${id}]`,
			key,
			literal,
		);
		props.store.applySettingsText(text);
	};

	const setManagement = (id: PackageId, management: "self" | "ecr") => {
		edit(id, "management", JSON.stringify(management));
		props.store.setStatus(
			management === "ecr"
				? `ecr now manages ${id}`
				: `${id} is yours to manage`,
		);
	};

	return (
		<div class="scroll-y flex-1 p-4">
			<p class="mb-4 max-w-2xl text-xs leading-relaxed text-ink-3">
				<b class="text-ink-2">Self-managed</b> means your system already owns the
				configuration — ecr reads it and never writes it.{" "}
				<b class="text-ink-2">Managed by ecr</b> hands the file to ecr, which
				generates it from the accounts on the{" "}
				<button
					type="button"
					class="text-obligation underline"
					onClick={props.onShowAccounts}
				>
					Accounts
				</button>{" "}
				tab.
			</p>

			<For each={PACKAGE_IDS}>
				{(id) => {
					const managed = () =>
						props.store.settings().packages[id]?.management === "ecr";
					const label = PACKAGE_LABELS[id];

					return (
						<section class="mb-3 rounded border border-rule bg-card">
							{/*
                Stacked until there is room for a row. The pair of choices is
                wide and does not shrink, so beside it the description was
                squeezed to a column one word wide and the card became taller
                than the screen.
              */}
							<div class="flex flex-col gap-2 border-b border-rule-soft px-3 py-2 md:flex-row md:flex-wrap md:items-center md:gap-3">
								<div class="min-w-0 flex-1">
									<div class="text-ink">{label.title}</div>
									<div class="text-xs text-ink-3">
										{label.purpose} · {label.file}
									</div>
								</div>

								<div class="flex shrink-0 self-start overflow-hidden rounded border border-rule md:self-auto">
									<Choice
										label="self-managed"
										active={!managed()}
										onSelect={() => setManagement(id, "self")}
									/>
									<Choice
										label="managed by ecr"
										active={managed()}
										onSelect={() => setManagement(id, "ecr")}
									/>
								</div>
							</div>

							{/*
                A self-managed package has nothing to edit, and a managed one is
                generated from the accounts on the Accounts tab — so neither
                shows a box. Five dead boxes filled the page and implied the
                config mattered when it is ignored.
              */}
							<Show
								when={managed()}
								fallback={
									<p class="px-3 py-2 text-xs text-ink-3">
										Your system owns this. ecr reads {label.file} and never
										writes it.
									</p>
								}
							>
								<p class="px-3 py-2 text-xs text-ink-3">
									ecr generates this from the accounts on the Accounts tab.
								</p>
							</Show>
						</section>
					);
				}}
			</For>
		</div>
	);
}
