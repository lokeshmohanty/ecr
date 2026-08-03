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
import { For, Index, Match, Show, Switch, createResource, createSignal } from "solid-js";
import {
  CLIENT_KEYS,
  DEFAULT_PREFERENCES,
  PREFERENCE_DOCS,
  SECTIONS,
  type Preferences,
} from "../state/settings";
import { DATE_FORMATS } from "../state/datetime";
import { SECTION_IDS, type CustomView } from "../state/views";
import { checkForUpdate, type UpdateState } from "../state/updates";
import { apkVersion, canScanQr, openExternal } from "../api/platform";
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

      <Pairing store={props.store} />
      <Updates />
    </div>
  );
}

/**
 * Re-pairing by camera, which belongs to the device for the same reason the
 * theme does: which server this phone talks to, and with which token, is not
 * something the mailbox has an opinion about.
 *
 * Absent wherever there is no camera, rather than shown and refused — the
 * desktop's answer to "point this somewhere else" is the address field the
 * thread list already offers.
 */
function Pairing(props: { store: AppStore }) {
  const [state, setState] = createSignal("");
  const [scanning, setScanning] = createSignal(false);

  const scan = async () => {
    setState("");
    setScanning(true);
    const reason = await props.store.pairByScanning();
    setScanning(false);
    // "" is either a scan that worked or one the reader backed out of, and
    // neither wants a message: the address on screen is the answer.
    setState(reason);
  };

  return (
    <Show when={canScanQr()}>
      <section class="mb-5">
        <h2 class="label mb-1">Server</h2>
        <p class="mb-2 text-xs text-ink-3">
          Scanning a pairing code replaces both the address and the token, so
          this is how to point this device at a different server — or at the
          same one after it moved.
        </p>

        <div class="mb-2 rounded border border-rule bg-card px-3 py-2">
          <div class="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
            <div class="min-w-0 flex-1">
              <div class="mono break-all text-ink">
                {props.store.connection().baseUrl || "no address yet"}
              </div>
              <div class="text-xs text-ink-3" role="status" aria-live="polite">
                {state() || (scanning() ? "point the camera at the code" : "")}
              </div>
            </div>
            <button
              type="button"
              class="touch-target rounded border border-rule px-3 py-1.5 disabled:opacity-50"
              disabled={scanning()}
              onClick={() => void scan()}
            >
              {scanning() ? "scanning…" : "Scan a code"}
            </button>
          </div>
        </div>
      </section>
    </Show>
  );
}

/**
 * The update check, which is here and nowhere else because it belongs to the
 * device in the same way the theme does — one phone can be a version behind
 * without that being true of anything else reading the same mailbox.
 *
 * The section is absent, not disabled, wherever there is no APK: a control that
 * cannot do anything is worse than no control, and on the desktop the answer to
 * "is there a newer version" is the package manager's to give.
 */
function Updates() {
  const [installed] = createResource(apkVersion);
  const [state, setState] = createSignal<UpdateState>({ kind: "unchecked" });

  const check = async (version: string) => {
    setState({ kind: "checking" });
    setState(await checkForUpdate(version));
  };

  return (
    <Show when={installed()}>
      {(version) => (
        <section class="mb-5">
          <h2 class="label mb-1">Updates</h2>
          <p class="mb-2 text-xs text-ink-3">
            This build was installed as an APK, so nothing updates it on its own.
            The check asks GitHub for the newest release; it happens when you ask
            for it and at no other time.
          </p>

          <div class="mb-2 rounded border border-rule bg-card px-3 py-2">
            <div class="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
              <div class="min-w-0 flex-1">
                <div class="text-ink">
                  Version <span class="mono">{version()}</span>
                </div>
                {/*
                  Announced, not just painted: the result of pressing the button
                  is this line changing, and a reader who cannot see it changing
                  has no way to know the check finished.
                */}
                <div class="text-xs leading-relaxed text-ink-3" aria-live="polite">
                  {message(state())}
                </div>
              </div>

              {/* Wrapped: three buttons and a version number do not fit one
                  phone-width row, and the third would go off the edge. */}
              <div class="flex shrink-0 flex-wrap gap-1 self-start md:self-auto">
                <button
                  type="button"
                  class="touch-target rounded border border-rule px-2 py-1 text-xs text-ink-2 hover:bg-neutral-bg"
                  disabled={state().kind === "checking"}
                  onClick={() => void check(version())}
                >
                  {state().kind === "unchecked" ? "check" : "check again"}
                </button>

                {/*
                  The download leaves the app on purpose. Fetching the APK here
                  would need `REQUEST_INSTALL_PACKAGES` and a FileProvider to
                  hand it to the installer; the browser reaches that same
                  installer with nothing added to the manifest.
                */}
                <Show when={available(state())}>
                  {(release) => (
                    <>
                      <Show when={release().apk}>
                        {(apk) => (
                          <button
                            type="button"
                            class="touch-target rounded border border-obligation bg-obligation-bg px-2 py-1 text-xs text-ink"
                            onClick={() => void openExternal(apk())}
                          >
                            download {release().version}
                          </button>
                        )}
                      </Show>
                      <button
                        type="button"
                        class="touch-target rounded border border-rule px-2 py-1 text-xs text-ink-2 hover:bg-neutral-bg"
                        onClick={() => void openExternal(release().page)}
                      >
                        release notes
                      </button>
                    </>
                  )}
                </Show>
              </div>
            </div>
          </div>
        </section>
      )}
    </Show>
  );
}

/** Narrows to the release, so the buttons do not each re-test the state's kind. */
function available(state: UpdateState) {
  return state.kind === "available" ? state.release : undefined;
}

/**
 * The one line under the version, for every state the check can be in.
 *
 * A failure names its reason rather than saying nothing, because the state a
 * failed check must never be confused with is "you are up to date".
 */
function message(state: UpdateState): string {
  switch (state.kind) {
    case "unchecked":
      return "Not checked since the app started.";
    case "checking":
      return "Asking GitHub…";
    case "current":
      return "This is the newest release.";
    case "failed":
      return `Could not check — ${state.reason}.`;
    case "available":
      return state.release.apk
        ? `${state.release.version} is available.`
        : `${state.release.version} is available, but that release carries no APK.`;
  }
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

      <Match when={props.name === "sidebarCustom"}>
        <QueryRows
          rows={props.value as CustomView[]}
          onSet={(rows) => props.onSet(props.name, rows as never)}
        />
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

/**
 * The saved queries, as rows rather than as a line of TOML.
 *
 * This is the one client-scoped option that is a list of records, and it is the
 * one there was no way to change: the device's half of the settings is not a
 * file, so "set this in the file" was an instruction that could not be carried
 * out on any device that had ever saved a preference.
 */
function QueryRows(props: {
  rows: CustomView[];
  onSet: (rows: CustomView[]) => void;
}) {
  const edit = (index: number, field: keyof CustomView, value: string) =>
    props.onSet(
      props.rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );

  return (
    <div class="flex w-full flex-col gap-2 md:w-[30rem]">
      {/*
        Index, not For: every edit replaces the whole list, and For keys on the
        item, so it would tear down the row being typed in. The fields commit on
        change — the second one committed while its own input was being rebuilt,
        and the value went with it.
      */}
      <Index each={props.rows}>
        {(row, index) => (
          <div class="flex items-center gap-1">
            <input
              type="text"
              class="w-8 shrink-0 rounded px-1 py-1 text-center"
              aria-label={`glyph for query ${index + 1}`}
              value={row().icon}
              onChange={(e) => edit(index, "icon", e.currentTarget.value)}
            />
            <input
              type="text"
              class="w-28 shrink-0 rounded px-2 py-1"
              placeholder="name"
              aria-label={`name of query ${index + 1}`}
              value={row().name}
              onChange={(e) => edit(index, "name", e.currentTarget.value)}
            />
            <input
              type="text"
              class="mono min-w-0 flex-1 rounded px-2 py-1 text-xs"
              placeholder="notmuch query"
              aria-label={`query ${index + 1}`}
              value={row().query}
              onChange={(e) => edit(index, "query", e.currentTarget.value)}
            />
            <button
              type="button"
              class="touch-target shrink-0 rounded px-2 text-ink-3"
              aria-label={`remove query ${row().name || index + 1}`}
              onClick={() => props.onSet(props.rows.filter((_, i) => i !== index))}
            >
              ✕
            </button>
          </div>
        )}
      </Index>

      <button
        type="button"
        class="touch-target self-start rounded border border-rule px-2 py-1 text-xs text-ink-2"
        onClick={() => props.onSet([...props.rows, { name: "", query: "", icon: "◆" }])}
      >
        + add query
      </button>
    </div>
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
