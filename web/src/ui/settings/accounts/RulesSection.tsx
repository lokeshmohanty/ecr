import { For, Show, createSignal } from "solid-js";
import type { ManagedRule } from "../../../api/types";

/**
 * Tagging rules, in the order they run.
 *
 * Order is part of what a rule set means — they run top to bottom, and one that
 * files a message stops a later one seeing it — so the whole set is saved at
 * once and moving a rule is an ordinary edit rather than something the API
 * cannot express.
 */
export function RulesSection(props: {
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
