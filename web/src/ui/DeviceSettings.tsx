/**
 * The half of the settings that belongs to this device, as controls.
 *
 * The shared file is a commented TOML document because it is edited rarely and
 * read carefully. This half is the opposite: it is the theme, the density, the
 * date format — things you change by trying them, on whichever screen you are
 * holding. So it is switches and pickers, generated from the same table that
 * documents the file, which is what stops an option existing in one and not
 * the other.
 */
import { For, Match, Show, Switch } from "solid-js";
import {
  CLIENT_KEYS,
  DEFAULT_PREFERENCES,
  PREFERENCE_DOCS,
  SECTIONS,
  type Preferences,
} from "../state/settings";
import { DATE_FORMATS } from "../state/datetime";
import { SECTION_IDS } from "../state/views";
import type { AppStore } from "../state/store";

export function DeviceSettings(props: { store: AppStore }) {
  const preferences = () => props.store.settings().preferences;

  const set = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    const settings = props.store.settings();
    props.store.setSettings({
      ...settings,
      preferences: { ...settings.preferences, [key]: value },
    });
  };

  /** Only the sections that actually hold something this device owns. */
  const sections = () =>
    SECTIONS.map((section) => ({
      section,
      keys: CLIENT_KEYS.filter((key) => PREFERENCE_DOCS[key].section === section.id),
    })).filter((entry) => entry.keys.length > 0);

  return (
    <div class="scroll-y flex-1 p-4">
      <p class="mb-4 max-w-2xl text-xs leading-relaxed text-ink-3">
        These belong to <b class="text-ink-2">this device</b> and are kept on it,
        so a phone and a desktop reading the same mailbox can look and behave
        differently. Everything about the mail itself — where you start, how
        messages are read — is shared, and lives in the file under{" "}
        <span class="mono text-ink-2">Preferences</span>.
      </p>

      <For each={sections()}>
        {({ section, keys }) => (
          <section class="mb-5">
            <h2 class="label mb-1">{section.title}</h2>
            <p class="mb-2 text-xs text-ink-3">{section.blurb}</p>

            <For each={keys}>
              {(key) => (
                <div class="mb-2 rounded border border-rule bg-card px-3 py-2">
                  <div class="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
                    <label class="min-w-0 flex-1" for={`pref-${key}`}>
                      <div class="text-ink">{title(key)}</div>
                      {/*
                        The whole explanation, unwrapped. The file's prose is
                        hard-wrapped for a terminal, so taking the first line
                        cut every sentence in half.
                      */}
                      <div class="text-xs leading-relaxed text-ink-3">
                        {PREFERENCE_DOCS[key].doc.replace(/\n/g, " ")}
                      </div>
                    </label>

                    <div class="shrink-0 self-start md:self-auto">
                      <Field id={`pref-${key}`} name={key} value={preferences()[key]} onSet={set} />
                    </div>
                  </div>
                </div>
              )}
            </For>
          </section>
        )}
      </For>
    </div>
  );
}

/** `sidebarIcons` reads as "Sidebar icons" without a second table to maintain. */
function title(key: string): string {
  const spaced = key.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`);
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function Field(props: {
  id: string;
  name: keyof Preferences;
  value: Preferences[keyof Preferences];
  onSet: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
}) {
  return (
    <Switch
      fallback={
        <span class="mono text-xs text-ink-3">set this in the file</span>
      }
    >
      <Match when={typeof props.value === "boolean"}>
        <button
          type="button"
          id={props.id}
          class="touch-target flex w-14 items-center rounded-full border border-rule p-0.5"
          classList={{ "bg-obligation": props.value === true, "bg-neutral-bg": !props.value }}
          role="switch"
          aria-checked={props.value === true}
          onClick={() => props.onSet(props.name, !props.value as never)}
        >
          <span
            class="size-5 rounded-full bg-paper transition-transform"
            classList={{ "translate-x-7": props.value === true }}
          />
        </button>
      </Match>

      <Match when={props.name === "listDateFormat"}>
        <Picker
          id={props.id}
          options={[...DATE_FORMATS]}
          value={String(props.value)}
          onPick={(v) => props.onSet(props.name, v as never)}
        />
      </Match>

      <Match when={props.name === "sidebarSections"}>
        <div class="flex flex-wrap gap-1">
          <For each={SECTION_IDS}>
            {(id) => {
              const on = () => (props.value as string[]).includes(id);
              return (
                <button
                  type="button"
                  class="touch-target rounded border px-2 py-1 text-xs"
                  classList={{
                    "border-obligation bg-obligation-bg text-ink": on(),
                    "border-rule text-ink-3": !on(),
                  }}
                  aria-pressed={on()}
                  onClick={() => {
                    const current = props.value as string[];
                    // Kept in the order the sections are declared, so toggling
                    // one off and on again does not reorder the sidebar.
                    const next = on()
                      ? current.filter((s) => s !== id)
                      : SECTION_IDS.filter((s) => s === id || current.includes(s));
                    props.onSet(props.name, next as never);
                  }}
                >
                  {id}
                </button>
              );
            }}
          </For>
        </div>
      </Match>

      <Match when={typeof props.value === "number"}>
        <input
          id={props.id}
          type="number"
          inputmode="numeric"
          class="w-24 rounded px-2 py-1 text-right"
          value={String(props.value)}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            if (Number.isFinite(next) && next > 0) props.onSet(props.name, next as never);
            else event.currentTarget.value = String(DEFAULT_PREFERENCES[props.name]);
          }}
        />
      </Match>

      <Match when={typeof props.value === "string"}>
        <input
          id={props.id}
          type="text"
          class="w-48 max-w-full rounded px-2 py-1"
          value={String(props.value)}
          onChange={(event) => props.onSet(props.name, event.currentTarget.value as never)}
        />
      </Match>
    </Switch>
  );
}

function Picker(props: {
  id: string;
  options: readonly string[];
  value: string;
  onPick: (value: string) => void;
}) {
  return (
    <div class="flex flex-wrap gap-1" id={props.id}>
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            class="touch-target rounded border px-2 py-1 text-xs"
            classList={{
              "border-obligation bg-obligation-bg text-ink": props.value === option,
              "border-rule text-ink-3": props.value !== option,
            }}
            aria-pressed={props.value === option}
            onClick={() => props.onPick(option)}
          >
            {option}
          </button>
        )}
      </For>
      <Show when={!props.options.includes(props.value)}>
        <span class="mono self-center text-xs text-ink-3">{props.value}</span>
      </Show>
    </div>
  );
}
