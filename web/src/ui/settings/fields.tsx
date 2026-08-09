import { Show, type JSX } from "solid-js";

/**
 * The form primitives every settings tab draws with.
 *
 * They live here rather than beside one tab because two tabs using slightly
 * different labels is how a settings page stops looking like one page.
 */
export function Field(props: {
	label: string;
	hint?: string;
	children: JSX.Element;
}) {
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

/** One half of a two-state segmented control. */
export function Choice(props: {
	label: string;
	active: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			class="px-2 py-1 text-xs"
			classList={{
				"bg-obligation text-paper": props.active,
				"text-ink-2 hover:bg-neutral-bg": !props.active,
			}}
			onClick={props.onSelect}
		>
			{props.label}
		</button>
	);
}

export function TextInput(props: {
	value: string;
	placeholder?: string;
	mono?: boolean;
	onInput: (value: string) => void;
}) {
	return (
		<input
			class="w-full rounded border border-rule bg-paper px-2 py-1 text-sm"
			classList={{ mono: props.mono }}
			value={props.value}
			placeholder={props.placeholder}
			onInput={(event) => props.onInput(event.currentTarget.value)}
		/>
	);
}

/** The ordinary bordered button the settings pages use for an action. */
export function Action(props: {
	label: string;
	disabled?: boolean;
	primary?: boolean;
	title?: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={props.disabled}
			title={props.title}
			class="touch-target rounded border px-2 py-1 text-xs disabled:opacity-50"
			classList={{
				"border-obligation bg-obligation text-paper": props.primary,
				"border-rule text-ink-2 hover:bg-neutral-bg": !props.primary,
			}}
			onClick={props.onClick}
		>
			{props.label}
		</button>
	);
}
