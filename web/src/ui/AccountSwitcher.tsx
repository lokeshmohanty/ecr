import { For } from "solid-js";
import type { AccountKey } from "../state/account-keys";

/**
 * The accounts, each behind one key.
 *
 * A list rather than a prompt: `]a`/`[a` already walk the accounts one at a
 * time, and what that cannot do is go to the fourth one without passing
 * through the second and third — each of which loads a mailbox on the way.
 * One keystroke, one account, and the letters are on screen so there is
 * nothing to remember before using it.
 *
 * The keys themselves are handled by the app, not here. A menu that captured
 * its own keyboard would be a fourth thing competing for keystrokes with the
 * panes, the palette and the editor, and the app already knows which of those
 * is on.
 */
export function AccountSwitcher(props: {
	rows: AccountKey[];
	current: string;
	onPick: (id: string) => void;
	onClose: () => void;
}) {
	return (
		<div
			class="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-4"
			onClick={props.onClose}
		>
			<div
				class="max-h-full w-full max-w-sm overflow-y-auto rounded border border-rule bg-paper-2 p-4"
				onClick={(event) => event.stopPropagation()}
				role="dialog"
				aria-label="Switch account"
			>
				<h2 class="mb-3 uppercase tracking-widest text-ink-3">
					Switch account
				</h2>

				<ul>
					<For each={props.rows}>
						{(row) => (
							<li>
								<button
									type="button"
									class="touch-target flex w-full items-baseline gap-3 rounded px-2 py-1.5 text-left"
									classList={{
										"bg-obligation-bg text-ink": row.id === props.current,
										"hover:bg-neutral-bg": row.id !== props.current,
									}}
									onClick={() => props.onPick(row.id)}
								>
									<kbd class="shrink-0">{row.key}</kbd>
									<span class="truncate-cell flex-1">{row.label}</span>
									<span class="shrink-0 truncate text-xs text-ink-3">
										{row.address}
									</span>
								</button>
							</li>
						)}
					</For>
				</ul>

				<p class="mt-3 text-xs text-ink-3">
					Press a key, or Escape to close.
				</p>
			</div>
		</div>
	);
}
