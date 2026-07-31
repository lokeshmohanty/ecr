import { For, Show, createSignal } from "solid-js";
import type { AppStore } from "../state/store";
import { defaultSettings, fromText, toText } from "../state/settings";
import { VimEditor } from "./VimEditor";

export function SettingsPane(props: { store: AppStore; onClose: () => void }) {
  const [errors, setErrors] = createSignal<string[]>([]);
  const [source, setSource] = createSignal(toText(props.store.settings()));

  const apply = (text: string) => {
    const { settings, errors: found } = fromText(text);
    setErrors(found);

    if (found.length > 0) return;

    props.store.setSettings(settings);
    props.store.setStatus("settings saved");
    props.onClose();
  };

  const reset = () => {
    setSource(toText(defaultSettings()));
    setErrors([]);
    props.store.setStatus("defaults loaded — ZZ to apply");
  };

  return (
    <>
      <header class="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3">
        <div class="min-w-0 flex-1">
          <h1 class="text-base text-text-strong">Settings</h1>
          <div class="text-xs text-text-dim">
            preferences and keybindings · <kbd>ZZ</kbd> apply · <kbd>ZQ</kbd> discard
          </div>
        </div>
        <button
          type="button"
          class="touch-target shrink-0 rounded border border-border px-2 py-1 text-xs text-text-secondary hover:bg-bg-hover"
          onClick={reset}
        >
          load defaults
        </button>
      </header>

      <Show when={errors().length > 0}>
        <div class="shrink-0 border-b border-tag-urgent bg-bg-tag-urgent px-4 py-2 text-xs text-tag-urgent">
          <p class="mb-1 font-semibold">not applied:</p>
          <ul class="space-y-0.5">
            <For each={errors()}>{(error) => <li>{error}</li>}</For>
          </ul>
        </div>
      </Show>

      <VimEditor
        initial={source()}
        label="settings"
        submitLabel="apply"
        onSubmit={apply}
        onCancel={props.onClose}
        onModeChange={(mode) => props.store.setMode(mode === "insert" ? "insert" : "normal")}
      />
    </>
  );
}
