import { For, Show } from "solid-js";
import type { AppStore } from "../state/store";

export function TopBar(props: { store: AppStore; onSync: () => void; onSettings: () => void }) {
  return (
    <header class="flex items-center gap-3 border-b border-border bg-bg-panel px-3 py-2">
      <span class="hidden shrink-0 font-semibold tracking-widest text-accent sm:block">
        ECR
      </span>

      <div class="flex min-w-0 flex-1 items-center gap-2 rounded border border-border bg-bg-input px-2 py-1">
        <span class="text-text-dim">query:</span>
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
        class="touch-target shrink-0 rounded px-2 py-1 uppercase text-text-secondary hover:bg-bg-hover disabled:opacity-50"
        disabled={props.store.syncing()}
        onClick={props.onSync}
        title="Sync (s)"
      >
        {props.store.syncing() ? "⟳ syncing" : "⟳ sync"}
      </button>

      <button
        type="button"
        class="touch-target shrink-0 rounded px-2 py-1 text-text-secondary hover:bg-bg-hover"
        onClick={props.onSettings}
        title="Settings (,)"
        aria-label="Settings"
      >
        ⚙
      </button>
    </header>
  );
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
    <footer class="flex items-center gap-3 border-t border-border bg-bg-panel px-3 py-1 text-xs">
      <span
        class="shrink-0 rounded px-1.5 py-0.5 font-semibold uppercase"
        classList={{
          "bg-accent text-bg-raised": props.store.mode() === "normal",
          "bg-tag-unread text-bg-raised": props.store.mode() === "insert",
          "bg-tag-default text-bg-raised":
            props.store.mode() === "command" || props.store.mode() === "search",
        }}
      >
        {props.store.mode()}
      </span>

      <span class="shrink-0 rounded border border-border px-1.5 py-0.5 uppercase text-text-dim">
        {props.store.pane()}
      </span>

      <span class="hidden min-w-0 flex-1 gap-3 md:flex">
        <For each={hints}>
          {([key, label]) => (
            <span class="shrink-0 text-text-dim">
              <kbd>{key}</kbd>:{label}
            </span>
          )}
        </For>
      </span>

      <span class="truncate-cell flex-1 text-text-secondary md:flex-none md:text-right">
        {props.store.status()}
      </span>

      <Show when={markCount() > 0}>
        <span class="shrink-0 rounded bg-bg-tag-urgent px-1.5 py-0.5 text-tag-urgent">
          {markCount()} marked
        </span>
      </Show>

      <Show when={props.store.pendingKeys()}>
        <span class="shrink-0 text-accent">{props.store.pendingKeys()}</span>
      </Show>

      <span
        class="shrink-0"
        classList={{
          "text-tag-unread": props.store.connected(),
          "text-tag-urgent": !props.store.connected(),
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
        class="max-h-full w-full max-w-lg overflow-y-auto rounded border border-border bg-bg-panel p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 class="mb-1 uppercase tracking-widest text-text-dim">Keybindings</h2>
        <p class="mb-3 text-xs text-text-dim">
          active in the <span class="text-accent">{props.pane}</span> pane · <kbd>h</kbd>/
          <kbd>l</kbd> move between panes
        </p>
        <dl class="grid grid-cols-[6rem_minmax(0,1fr)] gap-y-1">
          <For each={props.bindings}>
            {(binding) => (
              <>
                <dt>
                  <kbd>{binding.keys}</kbd>
                </dt>
                <dd class="text-text-secondary">{binding.description}</dd>
              </>
            )}
          </For>
        </dl>
        <p class="mt-4 text-xs text-text-dim">Escape or click outside to close.</p>
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
        class="w-full max-w-md rounded border border-border bg-bg-panel p-5"
        onSubmit={(e) => {
          e.preventDefault();
          props.store.setConnection({
            baseUrl: urlInput?.value.trim() ?? "",
            token: tokenInput?.value.trim() ?? "",
          });
        }}
      >
        <h1 class="mb-1 text-base text-accent">Connect to ecr-server</h1>
        <p class="mb-4 text-xs text-text-dim">
          Issue a token on the server with{" "}
          <code>ecr-server token new &lt;name&gt;</code>.
        </p>

        <label class="mb-3 block">
          <span class="text-xs uppercase text-text-dim">Server URL</span>
          <input
            ref={urlInput}
            class="touch-target mt-1 w-full rounded px-2 py-1.5"
            value={props.store.connection().baseUrl}
            placeholder="http://your-host:8383"
          />
        </label>

        <label class="mb-4 block">
          <span class="text-xs uppercase text-text-dim">Device token</span>
          <input
            ref={tokenInput}
            type="password"
            class="touch-target mt-1 w-full rounded px-2 py-1.5"
            value={props.store.connection().token}
          />
        </label>

        <button
          type="submit"
          class="touch-target w-full rounded bg-accent px-3 py-2 font-semibold text-bg-raised"
        >
          Connect
        </button>

        <Show when={props.store.status()}>
          <p class="mt-3 text-xs text-tag-urgent">{props.store.status()}</p>
        </Show>
      </form>
    </div>
  );
}
