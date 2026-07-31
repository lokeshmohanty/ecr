import { For, Show } from "solid-js";
import type { AppStore } from "../state/store";
import { ALL_ACCOUNTS } from "../state/views";

export function TopBar(props: { store: AppStore; onSync: () => void; onSettings: () => void }) {
  return (
    <header class="flex items-center gap-3 border-b border-rule bg-paper-2 px-3 py-2">
      <span class="hidden shrink-0 font-semibold tracking-widest text-obligation sm:block">
        ECR
      </span>

      <div class="flex min-w-0 flex-1 items-center gap-2 rounded border border-rule bg-paper-2 px-2 py-1">
        <span class="text-ink-3">query:</span>
        <input
          class="w-full border-0 bg-transparent p-0 outline-none"
          value={props.store.query()}
          onChange={(e) => {
            props.store.setQuery(e.currentTarget.value);
            props.store.setSelected(0);
          }}
          onFocus={() => props.store.setMode("insert")}
          onBlur={() => props.store.setMode("normal")}
        />
      </div>

      <button
        type="button"
        class="touch-target shrink-0 rounded px-2 py-1 uppercase text-ink-2 hover:bg-neutral-bg disabled:opacity-50"
        disabled={props.store.syncing()}
        onClick={props.onSync}
        title="Sync (s)"
      >
        {props.store.syncing() ? "⟳ syncing" : "⟳ sync"}
      </button>

      <button
        type="button"
        class="touch-target shrink-0 rounded px-2 py-1 text-ink-2 hover:bg-neutral-bg"
        onClick={props.onSettings}
        title="Settings (,)"
        aria-label="Settings"
      >
        ⚙
      </button>
    </header>
  );
}

function accountName(store: AppStore): string {
  const id = store.currentAccount();
  if (id === ALL_ACCOUNTS) return "all accounts";

  const account = (store.accounts() ?? []).find((a) => a.id === id);
  return account?.address ?? id;
}

export function StatusBar(props: { store: AppStore }) {
  const markCount = () => Object.keys(props.store.marks).length;

  const hints = [
    ["h/l", "pane"],
    ["j/k", "nav"],
    ["Enter", "open"],
    ["r", "reply"],
    ["c", "compose"],
    ["x", "execute"],
    ["/", "search"],
    [",", "settings"],
    ["?", "help"],
  ];

  return (
    <footer class="flex items-center gap-3 border-t border-rule bg-paper-2 px-3 py-1 text-xs">
      <span
        class="shrink-0 rounded px-1.5 py-0.5 font-semibold uppercase"
        classList={{
          "bg-obligation text-paper": props.store.mode() === "normal",
          "bg-proved text-paper": props.store.mode() === "insert",
          "bg-neutral-bg text-ink": props.store.mode() === "command" || props.store.mode() === "search",
        }}
      >
        {props.store.mode()}
      </span>

      <span class="shrink-0 rounded border border-rule px-1.5 py-0.5 uppercase text-ink-3">
        {props.store.pane()}
      </span>

      <span
        class="shrink-0 rounded bg-neutral-bg px-1.5 py-0.5 text-ink-2"
        title="account this view is scoped to"
      >
        {accountName(props.store)}
      </span>

      <span class="hidden min-w-0 flex-1 gap-3 md:flex">
        <For each={hints}>
          {([key, label]) => (
            <span class="shrink-0 text-ink-3">
              <kbd>{key}</kbd>:{label}
            </span>
          )}
        </For>
      </span>

      <span class="truncate-cell flex-1 text-ink-2 md:flex-none md:text-right">
        {props.store.status()}
      </span>

      <Show when={markCount() > 0}>
        <span class="shrink-0 rounded bg-blocking-bg px-1.5 py-0.5 text-blocking">
          {markCount()} marked
        </span>
      </Show>

      <Show when={props.store.pendingKeys()}>
        <span class="shrink-0 text-obligation">{props.store.pendingKeys()}</span>
      </Show>

      <span
        class="shrink-0"
        classList={{
          "text-proved": props.store.connected(),
          "text-blocking": !props.store.connected(),
        }}
        title={props.store.connected() ? "connected" : "disconnected"}
      >
        ●
      </span>
    </footer>
  );
}

export function Help(props: {
  bindings: { keys: string; description: string }[];
  pane: string;
  onClose: () => void;
}) {
  return (
    <div
      class="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-4"
      onClick={props.onClose}
    >
      <div
        class="max-h-full w-full max-w-lg overflow-y-auto rounded border border-rule bg-paper-2 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 class="mb-1 uppercase tracking-widest text-ink-3">Keybindings</h2>
        <p class="mb-3 text-xs text-ink-3">
          active in the <span class="text-obligation">{props.pane}</span> pane · <kbd>h</kbd>/
          <kbd>l</kbd> move between panes
        </p>
        <dl class="grid grid-cols-[6rem_minmax(0,1fr)] gap-y-1">
          <For each={props.bindings}>
            {(binding) => (
              <>
                <dt>
                  <kbd>{binding.keys}</kbd>
                </dt>
                <dd class="text-ink-2">{binding.description}</dd>
              </>
            )}
          </For>
        </dl>
        <p class="mt-4 text-xs text-ink-3">Escape or click outside to close.</p>
      </div>
    </div>
  );
}

export function ConnectionSetup(props: { store: AppStore }) {
  let urlInput: HTMLInputElement | undefined;
  let tokenInput: HTMLInputElement | undefined;

  return (
    <div class="flex h-full items-center justify-center p-6">
      <form
        class="w-full max-w-md rounded border border-rule bg-paper-2 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          props.store.setConnection({
            baseUrl: urlInput?.value.trim() ?? "",
            token: tokenInput?.value.trim() ?? "",
          });
        }}
      >
        <h1 class="mb-1 text-base text-obligation">Connect to ecr-server</h1>
        <p class="mb-4 text-xs text-ink-3">
          Issue a token on the server with{" "}
          <code>ecr-server token new &lt;name&gt;</code>.
        </p>

        <label class="mb-3 block">
          <span class="text-xs uppercase text-ink-3">Server URL</span>
          <input
            ref={urlInput}
            class="touch-target mt-1 w-full rounded px-2 py-1.5"
            value={props.store.connection().baseUrl}
            placeholder="http://your-host:8383"
          />
        </label>

        <label class="mb-4 block">
          <span class="text-xs uppercase text-ink-3">Device token</span>
          <input
            ref={tokenInput}
            type="password"
            class="touch-target mt-1 w-full rounded px-2 py-1.5"
            value={props.store.connection().token}
          />
        </label>

        <button
          type="submit"
          class="touch-target w-full rounded bg-obligation px-3 py-2 font-semibold text-paper"
        >
          Connect
        </button>

        <Show when={props.store.status()}>
          <p class="mt-3 text-xs text-blocking">{props.store.status()}</p>
        </Show>
      </form>
    </div>
  );
}
