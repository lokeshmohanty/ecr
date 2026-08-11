import { For, Show, createSignal } from "solid-js";
import type { ManagedAccount, ManagedProvider } from "../../../api/types";
import { Field, TextArea, TextInput } from "../fields";
import { accountFrom, shown } from "./draft";

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

/**
 * Adding and editing an account are the same form, deliberately.
 *
 * They ask for the same things and validate them the same way, and two copies
 * of that is two places for a field to be forgotten — an edit form missing
 * `patterns` would silently drop it on every save, because the update route
 * replaces the whole account rather than patching it.
 *
 * That last point is why `existing` is spread back out below: everything this
 * form does not show is carried across untouched. Without it, editing an
 * address would reset `Expunge`, the folder overrides and the aliases to the
 * defaults, and the next sync would act on it.
 */
export function AccountForm(props: {
	busy: boolean;
	/** The account being edited, or nothing when this is a new one. */
	existing?: { id: string; account: ManagedAccount };
	onSubmit: (id: string, account: ManagedAccount) => void;
	onCancel: () => void;
}) {
	const editing = () => props.existing !== undefined;

	const [id, setId] = createSignal(props.existing?.id ?? "");
	const [address, setAddress] = createSignal(
		props.existing?.account.address ?? "",
	);
	const [name, setName] = createSignal(props.existing?.account.name ?? "");
	const [provider, setProvider] = createSignal<ManagedProvider>(
		props.existing?.account.provider ?? "gmail",
	);
	const [imap, setImap] = createSignal(shown(props.existing?.account.imap));
	const [smtp, setSmtp] = createSignal(shown(props.existing?.account.smtp));
	const [primary, setPrimary] = createSignal(
		props.existing?.account.primary ?? false,
	);
	const [enabled, setEnabled] = createSignal(
		props.existing?.account.enabled ?? true,
	);
	const [signature, setSignature] = createSignal(
		props.existing?.account.signature ?? "",
	);

	const generic = () => provider() === "generic";

	const submit = (event: Event) => {
		event.preventDefault();
		const chosen = id().trim();
		props.onSubmit(
			chosen,
			accountFrom(
				{
					address: address(),
					name: name(),
					provider: provider(),
					imap: imap(),
					smtp: smtp(),
					signature: signature(),
					primary: primary(),
					enabled: enabled(),
				},
				chosen,
				props.existing?.account,
			),
		);
	};

	return (
		<form class="space-y-3 rounded border border-rule p-3" onSubmit={submit}>
			<Field
				label="Name for it"
				hint="the folder under your maildir, and its tag"
			>
				{/*
          Renaming an account would rename the maildir it names and orphan
          every `path:` query and tag that already points at it, so the id is
          fixed once it exists.
        */}
				<Show
					when={!editing()}
					fallback={<div class="mono text-sm text-ink-2">{id()}</div>}
				>
					<TextInput value={id()} placeholder="personal" onInput={setId} />
				</Show>
			</Field>

			<Field label="Address">
				<TextInput
					value={address()}
					placeholder="you@example.com"
					onInput={setAddress}
				/>
			</Field>

			<Field label="Your name" hint="what goes on the From: line">
				<TextInput value={name()} onInput={setName} />
			</Field>

			{/*
        Written into the composer when a message is written from this address,
        above the `-- ` the client adds — so what is on screen is what is
        sent, and one message can be sent without it by deleting it there.
      */}
			<Field
				label="Signature"
				hint="added to the bottom of a new message from this address"
			>
				<TextArea
					value={signature()}
					rows={4}
					placeholder={"Ada Lovelace\nAnalytical Engines"}
					onInput={setSignature}
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
					<TextInput
						value={imap()}
						placeholder="imap.example.com"
						onInput={setImap}
					/>
				</Field>
				<Field label="SMTP" hint="host, or host:port">
					<TextInput
						value={smtp()}
						placeholder="smtp.example.com"
						onInput={setSmtp}
					/>
				</Field>
			</Show>

			<div class="flex flex-wrap gap-4 text-xs text-ink-2">
				<label class="flex items-center gap-1">
					<input
						type="checkbox"
						checked={primary()}
						onChange={(event) => setPrimary(event.currentTarget.checked)}
					/>
					primary
				</label>
				<label class="flex items-center gap-1">
					<input
						type="checkbox"
						checked={enabled()}
						onChange={(event) => setEnabled(event.currentTarget.checked)}
					/>
					enabled
				</label>
			</div>

			<Show when={!editing()}>
				<p class="text-xs text-ink-3">
					Gmail and Outlook need an OAuth token. Adding the account here writes
					the configuration for it; the token is granted afterwards, with the
					authorize button beside it or{" "}
					<code>ecr oauth setup {id() || "<name>"}</code> at a terminal.
				</p>
			</Show>

			<div class="flex gap-2">
				<button
					type="submit"
					disabled={props.busy || !id().trim() || !address().trim()}
					class="touch-target rounded border border-obligation bg-obligation px-3 py-1 text-xs text-paper disabled:opacity-50"
				>
					{editing() ? "save it" : "add it"}
				</button>
				<button
					type="button"
					class="touch-target rounded border border-rule px-3 py-1 text-xs text-ink-2"
					onClick={props.onCancel}
				>
					cancel
				</button>
			</div>
		</form>
	);
}
