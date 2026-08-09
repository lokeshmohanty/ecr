import { Show, createSignal } from "solid-js";
import type { AppStore } from "../../state/store";
import { DeviceSettings } from "./DeviceSettings";
import { PackagesSettings } from "./PackagesSettings";
import { SharedFileSettings } from "./SharedFileSettings";
import { Tabs, type Tab } from "./Tabs";
import { ThemeSettings } from "./ThemeSettings";
import { AccountsSettings } from "./accounts/AccountsSettings";

/**
 * The settings shell: a header, the tabs, and whichever page is showing.
 *
 * Each tab owns its own state and its own saving. That split is the point —
 * settings have **two owners**, and the pages that write the server's file and
 * the pages that write this device's are different pages for a reason. A
 * client-scoped option routed through the shared file's `applySettingsText`
 * discards the very change being made, and it does so silently.
 */
export function SettingsPane(props: { store: AppStore; onClose: () => void }) {
	const [tab, setTab] = createSignal<Tab>("device");

	return (
		<>
			<header class="shrink-0 border-b border-rule px-4 py-3">
				<div class="flex items-start gap-3">
					<div class="min-w-0 flex-1">
						<h1 class="text-base text-ink">Settings</h1>
						<div class="text-xs text-ink-3">
							<kbd>q</kbd> or <kbd>ZQ</kbd> to close
						</div>
					</div>
					<button
						type="button"
						class="touch-target shrink-0 rounded border border-rule px-2 py-1 text-xs text-ink-2 hover:bg-neutral-bg"
						onClick={props.onClose}
					>
						close
					</button>
				</div>

				{/*
          Wrapped, not scrolled: five tabs do not fit one phone-width row, and
          a tab that runs off the edge is a tab nobody finds — the shared file
          was unreachable there.
        */}
				<div class="mt-3 flex flex-wrap gap-1">
					<Tabs current={tab()} onSelect={setTab} />
				</div>
			</header>

			<Show when={tab() === "device"}>
				<DeviceSettings store={props.store} />
			</Show>

			<Show when={tab() === "theme"}>
				<ThemeSettings store={props.store} />
			</Show>

			<Show when={tab() === "packages"}>
				<PackagesSettings
					store={props.store}
					onShowAccounts={() => setTab("accounts")}
				/>
			</Show>

			<Show when={tab() === "accounts"}>
				<AccountsSettings store={props.store} />
			</Show>

			<Show when={tab() === "text"}>
				<SharedFileSettings store={props.store} onClose={props.onClose} />
			</Show>
		</>
	);
}
