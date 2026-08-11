import { For, Show } from "solid-js";
import type { AppStore } from "../state/store";
import type { OutboxEntry } from "../api/types";

/**
 * What has been written and has not gone.
 *
 * **It is above the list rather than a mailbox of its own**, because the
 * question it answers is asked in the seconds after pressing send and nowhere
 * else: a message that is on its way is not a thing to go and look for, it is
 * a thing that should be visible without being looked for. A queue nobody can
 * see is how a message that failed becomes a message that was never sent — the
 * composer closed, Sent shows nothing until the provider's own copy syncs back
 * minutes later, and the only account of what happened is in the server's log.
 *
 * It disappears the moment the queue empties, which is the ordinary case
 * within a few seconds of sending, so it costs a reader with nothing pending
 * exactly nothing.
 */
export function Outbox(props: { store: AppStore }) {
	const entries = () => props.store.outbox() ?? [];

	return (
		<Show when={entries().length > 0}>
			<div class="shrink-0 border-b border-rule bg-paper-2 px-3 py-2">
				<div class="mb-1 text-xs uppercase tracking-wide text-ink-3">
					outbox · {entries().length}
				</div>

				<ul class="space-y-1">
					<For each={entries()}>
						{(entry) => <Row store={props.store} entry={entry} />}
					</For>
				</ul>
			</div>
		</Show>
	);
}

function Row(props: { store: AppStore; entry: OutboxEntry }) {
	const failed = () => props.entry.last_error !== null;

	return (
		<li
			class="rounded border px-2 py-1 text-xs"
			classList={{
				"border-blocking bg-blocking-bg": failed(),
				"border-rule": !failed(),
			}}
		>
			<div class="flex items-baseline gap-2">
				<span class="truncate-cell flex-1 text-ink">
					{props.entry.subject || "(no subject)"}
				</span>
				<span class="shrink-0 text-ink-3">
					{props.entry.to.join(", ")}
				</span>
			</div>

			<div class="mt-0.5 flex items-baseline gap-2">
				{/*
          The reason, in full. A queue that retries silently is one where a
          wrong password looks like a slow network, and the reader has no way
          to know which of the two they are waiting for.
        */}
				<span
					class="flex-1 break-words"
					classList={{ "text-blocking": failed(), "text-ink-3": !failed() }}
				>
					{failed() ? props.entry.last_error : whenDue(props.entry.due)}
					<Show when={props.entry.attempts > 0}>
						{" "}
						· {props.entry.attempts} attempt
						{props.entry.attempts === 1 ? "" : "s"}
					</Show>
				</span>

				<Show when={failed()}>
					<button
						type="button"
						class="touch-target shrink-0 rounded border border-rule px-2 py-0.5 text-obligation hover:bg-neutral-bg"
						onClick={() => void props.store.retrySend(props.entry.id)}
					>
						try again
					</button>
				</Show>

				<button
					type="button"
					class="touch-target shrink-0 rounded border border-rule px-2 py-0.5 text-ink-2 hover:bg-neutral-bg"
					title="take it out of the queue — it is not sent and not kept"
					onClick={() => void props.store.unsendQueued(props.entry.id)}
				>
					discard
				</button>
			</div>
		</li>
	);
}

/**
 * How long until it goes, in the terms the wait is actually in.
 *
 * A clock time would be wrong for the ordinary case, which is ten seconds of
 * undo: "sending at 14:32:07" is a fact nobody wants about something that is
 * about to happen.
 */
function whenDue(due: number): string {
	const seconds = Math.round(due - Date.now() / 1000);
	if (seconds <= 0) return "sending";
	if (seconds < 60) return `sending in ${seconds}s`;
	if (seconds < 3600) return `waiting ${Math.round(seconds / 60)}m`;
	return `waiting ${Math.round(seconds / 3600)}h`;
}
