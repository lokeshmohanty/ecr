import { For, Show, createSignal } from "solid-js";
import type { AppStore } from "../state/store";
import { defaultSettings, fromText, toText } from "../state/settings";
import { PACKAGE_IDS, PACKAGE_LABELS, type PackageId } from "../state/packages";
import { VimEditor } from "./VimEditor";

type Tab = "packages" | "text";

export function SettingsPane(props: { store: AppStore; onClose: () => void }) {
  const [tab, setTab] = createSignal<Tab>("packages");
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

  const setManagement = (id: PackageId, management: "self" | "ecr") => {
    const next = structuredClone(props.store.settings());
    next.packages[id] = { ...next.packages[id], management };
    props.store.setSettings(next);
    setSource(toText(next));
    props.store.setStatus(
      management === "ecr" ? `ecr now manages ${id}` : `${id} is yours to manage`,
    );
  };

  const setConfig = (id: PackageId, config: string) => {
    const next = structuredClone(props.store.settings());
    next.packages[id] = { ...next.packages[id], config };
    props.store.setSettings(next);
    setSource(toText(next));
  };

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

        <div class="mt-3 flex gap-1">
          <Tabs current={tab()} onSelect={setTab} />
        </div>
      </header>

      <Show when={tab() === "packages"}>
        <div class="scroll-y flex-1 p-4">
          <p class="mb-4 max-w-2xl text-xs leading-relaxed text-ink-3">
            <b class="text-ink-2">Self-managed</b> means your system already
            owns the configuration — ecr reads it and never writes it, and anything
            entered here is ignored.{" "}
            <b class="text-ink-2">Managed by ecr</b> hands the file to ecr,
            and the box below becomes editable.
          </p>

          <For each={PACKAGE_IDS}>
            {(id) => {
              const config = () => props.store.settings().packages[id];
              const managed = () => config()?.management === "ecr";
              const label = PACKAGE_LABELS[id];

              return (
                <section class="mb-3 rounded border border-rule bg-card">
                  <div class="flex flex-wrap items-center gap-3 border-b border-rule-soft px-3 py-2">
                    <div class="min-w-0 flex-1">
                      <div class="text-ink">{label.title}</div>
                      <div class="text-xs text-ink-3">
                        {label.purpose} · {label.file}
                      </div>
                    </div>

                    <div class="flex shrink-0 overflow-hidden rounded border border-rule">
                      <Choice
                        label="self-managed"
                        active={!managed()}
                        onSelect={() => setManagement(id, "self")}
                      />
                      <Choice
                        label="managed by ecr"
                        active={managed()}
                        onSelect={() => setManagement(id, "ecr")}
                      />
                    </div>
                  </div>

                  <div class="p-3">
                    <textarea
                      class="h-28 w-full resize-y rounded p-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!managed()}
                      placeholder={
                        managed()
                          ? `contents of ${label.file}`
                          : "self-managed — ecr reads your existing configuration and ignores this"
                      }
                      value={config()?.config ?? ""}
                      onChange={(e) => setConfig(id, e.currentTarget.value)}
                    />
                  </div>
                </section>
              );
            }}
          </For>
        </div>
      </Show>

      <Show when={tab() === "text"}>
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
              setSource(toText(defaultSettings()));
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
          onModeChange={(mode) => props.store.setMode(mode === "insert" ? "insert" : "normal")}
        />
      </Show>
    </>
  );
}

function Tabs(props: { current: Tab; onSelect: (tab: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "packages", label: "Packages" },
    { id: "text", label: "Preferences & keys" },
  ];

  return (
    <For each={tabs}>
      {(tab) => (
        <button
          type="button"
          class="rounded px-3 py-1 text-xs uppercase tracking-wide"
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

function Choice(props: { label: string; active: boolean; onSelect: () => void }) {
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
