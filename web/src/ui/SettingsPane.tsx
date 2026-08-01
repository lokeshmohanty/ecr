import { For, Show, createSignal } from "solid-js";
import type { AppStore } from "../state/store";
import { defaultToml, tomlString, withValue } from "../state/settings";
import { PACKAGE_IDS, PACKAGE_LABELS, type PackageId } from "../state/packages";
import { VimEditor } from "./VimEditor";

type Tab = "theme" | "packages" | "text";

export function SettingsPane(props: { store: AppStore; onClose: () => void }) {
  const [tab, setTab] = createSignal<Tab>("packages");
  const [errors, setErrors] = createSignal<string[]>([]);
  const [source, setSource] = createSignal(props.store.settingsSource());

  const apply = (text: string) => {
    const found = props.store.applySettingsText(text);
    setErrors(found);
    if (found.length > 0) return;

    props.store.setStatus("settings saved");
    props.onClose();
  };

  // Edits the file in place rather than regenerating it, so a switch flipped
  // here never costs the user the comments they wrote.
  const edit = (id: PackageId, key: string, literal: string) => {
    const text = withValue(props.store.settingsSource(), `[packages.${id}]`, key, literal);
    props.store.applySettingsText(text);
    setSource(text);
  };

  const setManagement = (id: PackageId, management: "self" | "ecr") => {
    edit(id, "management", JSON.stringify(management));
    props.store.setStatus(
      management === "ecr" ? `ecr now manages ${id}` : `${id} is yours to manage`,
    );
  };

  const setConfig = (id: PackageId, config: string) => {
    edit(id, "config", tomlString(config));
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

      <Show when={tab() === "theme"}>
        <div class="scroll-y flex-1 p-4">
          <p class="mb-4 max-w-2xl text-xs leading-relaxed text-ink-3">
            Picking one applies it now — the whole client is repainted from the
            file, so what you see is the theme rather than a preview of it. Each
            lives in{" "}
            <span class="mono text-ink-2">~/.config/ecr/themes/</span>; copy one
            and edit it to make your own, and it will appear here.
          </p>

          <For each={props.store.themeList() ?? []}>
            {(entry) => {
              const active = () =>
                props.store.settings().preferences.theme === entry.path;

              return (
                <button
                  type="button"
                  class="touch-target mb-2 flex w-full items-center gap-3 rounded border px-3 py-2 text-left"
                  classList={{
                    "border-obligation bg-obligation-bg": active(),
                    "border-rule hover:bg-neutral-bg": !active(),
                  }}
                  aria-pressed={active()}
                  onClick={() => {
                    props.store.setTheme(entry.path);
                    props.store.setStatus(`theme: ${entry.name}`);
                  }}
                >
                  <div class="min-w-0 flex-1">
                    <div class="truncate-cell text-ink">{entry.name}</div>
                    <div class="truncate-cell mono text-xs text-ink-3">
                      {entry.path}
                    </div>
                  </div>
                  <Show when={!entry.builtin}>
                    <span class="label shrink-0 text-proved">yours</span>
                  </Show>
                  <Show when={active()}>
                    <span class="shrink-0 text-obligation">●</span>
                  </Show>
                </button>
              );
            }}
          </For>

          <Show when={(props.store.themeList() ?? []).length === 0}>
            <p class="text-xs text-ink-3">
              No themes yet — they are written when the server first answers.
            </p>
          </Show>
        </div>
      </Show>

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

                  {/*
                    A self-managed package has nothing to edit, so it shows one
                    line rather than a disabled box. Five dead boxes filled the
                    page and implied the config mattered when it is ignored.
                  */}
                  <Show
                    when={managed()}
                    fallback={
                      <p class="px-3 py-2 text-xs text-ink-3">
                        Your system owns this. ecr reads {label.file} and never writes it.
                      </p>
                    }
                  >
                    <div class="p-3">
                      <label class="mb-1 block text-xs text-ink-3" for={`pkg-${id}`}>
                        {label.file}
                      </label>
                      <textarea
                        id={`pkg-${id}`}
                        aria-label={`${label.title} configuration`}
                        class="h-32 w-full resize-y rounded p-2 text-xs"
                        placeholder={`contents of ${label.file}`}
                        value={config()?.config ?? ""}
                        onChange={(e) => setConfig(id, e.currentTarget.value)}
                      />
                    </div>
                  </Show>
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
          onModeChange={(mode) => props.store.setMode(mode === "insert" ? "insert" : "normal")}
        />
      </Show>
    </>
  );
}

function Tabs(props: { current: Tab; onSelect: (tab: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "theme", label: "Theme" },
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
