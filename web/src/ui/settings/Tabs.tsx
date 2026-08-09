import { For } from "solid-js";

export type Tab = "theme" | "device" | "packages" | "accounts" | "text";

const TABS: { id: Tab; label: string }[] = [
	{ id: "device", label: "This device" },
	{ id: "theme", label: "Theme" },
	{ id: "packages", label: "Packages" },
	{ id: "accounts", label: "Accounts" },
	// Keybindings left this file with the split, so the label no longer claims
	// them: they belong to the device and are edited on its own page.
	{ id: "text", label: "Shared file" },
];

export function Tabs(props: {
	current: Tab;
	onSelect: (tab: Tab) => void;
}) {
	return (
		<For each={TABS}>
			{(tab) => (
				<button
					type="button"
					class="touch-target shrink-0 rounded px-3 py-1 text-xs uppercase tracking-wide"
					classList={{
						"bg-obligation text-paper": props.current === tab.id,
						"text-ink-2 hover:bg-neutral-bg": props.current !== tab.id,
					}}
					onClick={() => props.onSelect(tab.id)}
				>
					{tab.label}
				</button>
			)}
		</For>
	);
}
