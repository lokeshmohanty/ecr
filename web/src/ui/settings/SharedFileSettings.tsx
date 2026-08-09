import { For, Show, createSignal } from "solid-js";
import type { AppStore } from "../../state/store";
import { defaultToml } from "../../state/settings";
import { VimEditor } from "../VimEditor";

/**
 * The half of the settings that is about the *mail* and is one answer for
 * everyone, edited as the file it is.
 *
 * It reports errors with line numbers rather than discarding a bad line, and it
 * is applied as a whole: `applySettingsText` preserves this device's half across
 * the edit, because the file no longer carries those keys and a save would
 * otherwise reset the theme and keybindings to their defaults.
 */
export function SharedFileSettings(props: {
	store: AppStore;
	onClose: () => void;
}) {
	const [errors, setErrors] = createSignal<string[]>([]);
	const [source, setSource] = createSignal(props.store.settingsSource());

	const apply = (text: string) => {
		const found = props.store.applySettingsText(text);
		setErrors(found);
		if (found.length > 0) return;

		props.store.setStatus("settings saved");
		props.onClose();
	};

	return (
		<>
			<Show when={errors().length > 0}>
				<div class="shrink-0 border-b border-blocking bg-blocking-bg px-4 py-2 text-xs text-blocking">
					<p class="mb-1 font-semibold">not applied:</p>
					<ul class="space-y-0.5">
						<For each={errors()}>{(error) => <li>{error}</li>}</For>
					</ul>
				</div>
			</Show>

			<div class="flex shrink-0 items-center gap-2 border-b border-rule px-4 py-2 text-xs text-ink-3">
				<span class="flex-1">preferences and keybindings</span>
				<button
					type="button"
					class="rounded border border-rule px-2 py-1 hover:bg-neutral-bg"
					onClick={() => {
						setSource(defaultToml());
						setErrors([]);
						props.store.setStatus("defaults loaded — ZZ to apply");
					}}
				>
					load defaults
				</button>
			</div>

			<VimEditor
				initial={source()}
				label="settings"
				submitLabel="apply"
				startMode={props.store.settings().preferences.editorStartMode}
				onSubmit={apply}
				onCancel={props.onClose}
				onModeChange={(mode) =>
					props.store.setMode(mode === "insert" ? "insert" : "normal")
				}
			/>
		</>
	);
}
