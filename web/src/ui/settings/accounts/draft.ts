import type {
	ManagedAccount,
	ManagedEndpoint,
	ManagedProvider,
} from "../../../api/types";

/** What the form actually asks for. Everything else is carried across. */
export interface Draft {
	address: string;
	name: string;
	provider: ManagedProvider;
	imap: string;
	smtp: string;
	primary: boolean;
	enabled: boolean;
}

export function hostPort(
	value: string,
	fallback: number,
): ManagedEndpoint | undefined {
	const [host, given] = value.split(":");
	if (!host) return undefined;
	return {
		host,
		port: given ? Number(given) : fallback,
		tls: fallback === 587 ? "starttls" : "implicit",
	};
}

export function shown(endpoint: ManagedEndpoint | undefined): string {
	if (!endpoint) return "";
	return `${endpoint.host}:${endpoint.port}`;
}

/**
 * The account to send, given what the form holds and what was there before.
 *
 * `PUT /api/v1/managed/accounts/:id` **replaces** the account rather than
 * patching it, so every field this form does not show has to be carried across
 * explicitly. Without that, editing an address resets `Expunge`, `Patterns`,
 * the folder overrides and the aliases to their defaults — and the next sync
 * acts on it, with a diff nobody was told to read as the only warning.
 *
 * The defaults below are therefore only ever reached for a *new* account:
 * deletion never propagates unless somebody asked for it.
 */
export function accountFrom(
	draft: Draft,
	id: string,
	existing?: ManagedAccount,
): ManagedAccount {
	const generic = draft.provider === "generic";

	return {
		...existing,
		address: draft.address.trim(),
		name: draft.name.trim() || undefined,
		provider: draft.provider,
		// A password command cannot be set over HTTP — the server refuses one,
		// because it is a command it would run — so an account that has one keeps
		// it rather than being silently converted to OAuth by an unrelated edit.
		auth: existing?.auth ?? { kind: "oauth", profile: id },
		imap: generic ? hostPort(draft.imap, 993) : existing?.imap,
		smtp: generic ? hostPort(draft.smtp, 587) : existing?.smtp,
		create: existing?.create ?? "near",
		expunge: existing?.expunge ?? "none",
		remove: existing?.remove ?? "none",
		primary: draft.primary,
		enabled: draft.enabled,
	};
}
