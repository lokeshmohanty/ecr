import { Show } from "solid-js";
import type { ManagedAccount, ManagedAuthState } from "../../../api/types";
import { Action } from "../fields";

/**
 * One account, its token, and the two things that can be done about it.
 *
 * The authorize buttons are drawn only when the client is on the machine the
 * server runs on. The flow they start redirects to *that* machine's loopback
 * address, so a phone that follows the link consents perfectly and then waits
 * for a callback it can never receive. A button that cannot work is worse than
 * an absent one — it reads as ecr being broken rather than as this being a thing
 * to do at the desk — so instead the phone is told where it can be done.
 */
export function AccountRow(props: {
	id: string;
	account: ManagedAccount;
	auth?: ManagedAuthState;
	local: boolean;
	busy: boolean;
	onEdit: () => void;
	onRemove: () => void;
	onAuthorize: (withDav: boolean) => void;
}) {
	const oauth = () => props.account.auth.kind === "oauth";
	const token = () => props.auth?.token;
	const usable = () =>
		token() === "valid" || token() === "refreshable";

	return (
		<li class="space-y-2 py-2">
			<div class="flex items-start gap-3">
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
							: // A password command is set at a terminal and shown here only
								// so the reader knows why there is nothing to edit.
								"password command (set at a terminal)"}
					</div>
				</div>

				<div class="flex shrink-0 gap-2">
					<Action label="edit" disabled={props.busy} onClick={props.onEdit} />
					<Action
						label="remove"
						disabled={props.busy}
						title="forgets the account; its mail is left exactly where it is"
						onClick={props.onRemove}
					/>
				</div>
			</div>

			<Show when={oauth() && props.auth}>
				{(auth) => (
					<div class="flex flex-wrap items-center gap-2 pl-0 text-xs">
						<span
							class="label"
							classList={{
								"text-proved": usable(),
								"text-blocking": !usable(),
							}}
						>
							token {auth().token}
						</span>

						<Show when={auth().dav_available}>
							<span
								class="label"
								classList={{
									"text-proved": auth().dav,
									"text-ink-3": !auth().dav,
								}}
							>
								{auth().dav
									? "contacts & calendars on"
									: "mail only"}
							</span>
						</Show>

						<Show
							when={props.local}
							fallback={
								<span class="text-ink-3">
									authorizing is done on the machine ecr runs on
								</span>
							}
						>
							<Action
								label={usable() ? "re-authorize" : "authorize"}
								disabled={props.busy}
								onClick={() => props.onAuthorize(false)}
							/>
							<Show when={auth().dav_available && !auth().dav}>
								<Action
									label="enable contacts & calendars"
									disabled={props.busy}
									title="asks for the extra permission, which needs one trip through the browser"
									onClick={() => props.onAuthorize(true)}
								/>
							</Show>
						</Show>
					</div>
				)}
			</Show>
		</li>
	);
}
