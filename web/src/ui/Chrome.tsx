import { For, Show, createSignal, onMount } from "solid-js";
import type { AppStore } from "../state/store";
import { canScanQr } from "../api/platform";
import { ALL_ACCOUNTS } from "../state/views";

export function TopBar(props: { store: AppStore; onSync: () => void; onSettings: () => void }) {
  return (
    // The desktop window has no title bar, so this is the only thing left to
    // drag it by. The attribute is inert everywhere else.
    <header
      data-tauri-drag-region
      class="chrome-top flex items-center gap-3 border-b border-rule bg-paper-2 px-3"
    >
      {/*
        `h` reaches the sidebar on a desktop; a phone has no keyboard and shows
        one pane at a time, so without this the views, tags and lists cannot be
        reached at all. It toggles, because the way back is the same journey.

        It is there for every width the sidebar is not, which is a setting
        rather than a breakpoint — so it is drawn from the same `layout()` the
        columns are, and not from a `md:hidden` that would disagree with it.
      */}
      <button
        type="button"
        class="touch-target shrink-0 rounded px-2 py-1 text-ink-2 hover:bg-neutral-bg"
        classList={{ hidden: props.store.layout() === "three" }}
        onClick={() =>
          props.store.setPane(props.store.pane() === "sidebar" ? "list" : "sidebar")
        }
        aria-label={props.store.pane() === "sidebar" ? "Close views" : "Views"}
        aria-expanded={props.store.pane() === "sidebar"}
      >
        ☰
      </button>

      <span
        data-tauri-drag-region
        class="hidden shrink-0 font-semibold tracking-widest text-obligation sm:block"
      >
        ECR
      </span>

      <input
        id="ecr-query"
        aria-label="notmuch query"
        class="query-input mono min-w-0 flex-1 px-4 py-1.5 text-center font-semibold"
        value={props.store.query()}
        onChange={(e) => {
          props.store.setQuery(e.currentTarget.value);
          props.store.setSelected(0);
        }}
        onFocus={() => props.store.setMode("insert")}
        onBlur={() => props.store.setMode("normal")}
      />

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

  /*
   * On a phone this strip costs a row of screen to say "all accounts" and
   * nothing else, above a bar that is already there. So it appears only when it
   * has something to report — a staged count, a failure, a bad line in the
   * settings file — and the account moves to the sidebar, where it is chosen.
   */
  const quiet = () =>
    !props.store.settingsProblem() &&
    props.store.serverChecks().length === 0 &&
    props.store.status() === "" &&
    markCount() === 0 &&
    props.store.pendingKeys() === "";

  return (
    <footer
      class="chrome-bottom flex items-center gap-3 border-t border-rule bg-paper-2 px-3 text-xs"
      classList={{ "max-md:hidden": quiet() }}
    >
      {/*
        The vim mode, and which pane has focus. Both are desktop facts: without
        a keyboard there is no mode to be in, and a phone shows one pane at a
        time so naming it says nothing you cannot see. The bar below carries
        the actions instead.
      */}
      <span
        class="hidden shrink-0 rounded px-1.5 py-0.5 font-semibold uppercase md:inline-block"
        classList={{
          "bg-obligation text-paper": props.store.mode() === "normal",
          "bg-proved text-paper": props.store.mode() === "insert",
          "bg-neutral-bg text-ink": props.store.mode() === "command" || props.store.mode() === "search",
        }}
      >
        {props.store.mode()}
      </span>

      <span
        class="hidden shrink-0 rounded border px-1.5 py-0.5 uppercase md:inline-block"
        classList={{
          "border-obligation text-obligation": props.store.viewing(),
          "border-rule text-ink-3": !props.store.viewing(),
        }}
      >
        {props.store.viewing() ? "view" : props.store.pane()}
      </span>

      <span
        class="hidden shrink-0 rounded bg-neutral-bg px-1.5 py-0.5 text-ink-2 md:inline-block"
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

      {/*
        A bad line in settings.toml outlives the transient status: it is still
        wrong until someone edits the file, so it stays put rather than being
        overwritten by the next thing that happened.
      */}
      <Show
        when={props.store.settingsProblem()}
        fallback={
          <span class="truncate-cell flex-1 text-ink-2 md:flex-none md:text-right">
            {props.store.status()}
          </span>
        }
      >
        {(problem) => (
          <span class="truncate-cell flex-1 text-blocking" title={problem()}>
            settings: {problem()}
          </span>
        )}
      </Show>

      <Show when={markCount() > 0}>
        <span class="shrink-0 rounded bg-blocking-bg px-1.5 py-0.5 text-blocking">
          {markCount()} marked
        </span>
      </Show>

      <Show when={props.store.pendingKeys()}>
        <span class="shrink-0 text-obligation">{props.store.pendingKeys()}</span>
      </Show>

      {/*
        The server started with warnings. They are not this client's to fix, but
        they are what a reader otherwise experiences as mail that quietly does
        not arrive — so they are said once, here, rather than being discovered
        by the absence of something.
      */}
      <Show when={props.store.serverChecks().length > 0}>
        <button
          type="button"
          class="touch-target shrink-0 rounded bg-obligation-bg px-1.5 py-0.5 text-obligation"
          onClick={() => props.store.setAskingDoctor(true)}
          title="the server's mail setup needs attention"
        >
          ! {props.store.serverChecks().length} check
          {props.store.serverChecks().length === 1 ? "" : "s"}
        </button>
      </Show>

      {/*
        Decorative, and deliberately still not a control. It is three pixels of
        colour in a strip that hides itself when it has nothing to say, so a
        click target here would be one nobody can find and nobody can hit. The
        two things it hints at are each reached from where they are reported:
        the checks from the badge beside it, the address from the thread list
        that is empty because of it.
      */}
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

/**
 * The server refused this device, and the only thing that fixes it is a token
 * pasted from `ecr token new`. It lays over the client rather than replacing it
 * because the address is already right — the browser is talking to the very
 * server that served it — so there is nothing to configure, only to prove. It
 * can be dismissed: the token has to be fetched from the server, which may take
 * a while, and the thread list offers the way back in meanwhile.
 */
export function AuthAlert(props: { store: AppStore; onClose: () => void }) {
  const [problem, setProblem] = createSignal("");
  const [checking, setChecking] = createSignal(false);
  let input: HTMLInputElement | undefined;

  // A prompt that opens without focus reads as inert, and every keystroke meant
  // for it would fall through to the panes behind.
  onMount(() => input?.focus());

  async function submit(event: Event) {
    event.preventDefault();
    setChecking(true);
    const reason = await props.store.authenticate(input?.value ?? "");
    setChecking(false);
    setProblem(reason);
    if (reason === "") props.onClose();
    else input?.focus();
  }

  /*
    Not `authenticate` over a scanned string: a code may carry an address as
    well, and `pairByScanning` is what probes that address and applies it before
    the token, so a code for a server this device has not been pointed at yet
    still works from here.
  */
  async function scan() {
    setProblem("");
    setChecking(true);
    const reason = await props.store.pairByScanning();
    setChecking(false);
    setProblem(reason);
    // A scan the reader backed out of answers "" too, and it has authorised
    // nothing — closing on that would dismiss the prompt for a camera that was
    // waved away, leaving the panes empty with the reason no longer on screen.
    // The refusal still standing is what tells the two apart.
    if (reason === "" && !props.store.needsToken()) props.onClose();
  }

  return (
    <div
      class="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ecr-auth-title"
      onClick={props.onClose}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        props.onClose();
      }}
    >
      <form
        class="w-full max-w-md rounded border border-blocking bg-paper-2 p-5"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
      >
        <h2 id="ecr-auth-title" class="mb-1 text-base text-blocking">
          this device is not authorised
        </h2>
        <p class="mb-4 text-xs text-ink-3">
          Issue a token on the server with{" "}
          <code>ecr token new &lt;name&gt;</code> — it is printed once — and
          paste it here.
        </p>

        <label class="mb-4 block">
          <span class="text-xs uppercase text-ink-3">Device token</span>
          <input
            ref={input}
            type="password"
            autocomplete="off"
            spellcheck={false}
            class="touch-target mono mt-1 w-full rounded px-2 py-1.5"
            placeholder="paste the token"
            aria-label="Device token"
            aria-invalid={problem() !== ""}
          />
        </label>

        <button
          type="submit"
          class="touch-target w-full rounded bg-obligation px-3 py-2 font-semibold text-paper disabled:opacity-50"
          disabled={checking()}
        >
          {checking() ? "checking…" : "Authenticate this device"}
        </button>

        {/*
          This is the only screen that asks for a token, and on a phone the
          alternative is 64 hex characters on a soft keyboard — so the camera
          belongs here at least as much as it does on the address prompt, which
          is where it used to be offered alone. A phone that could reach its
          server never saw that prompt, and so was never offered a scanner at
          all.

          The address is already right here — this server is the one that
          refused the device — so a code carrying nothing but a token is enough,
          and that is what `--qr` prints without `--url`. One that does carry an
          address is still honoured, and replaces this one.
        */}
        <Show when={canScanQr()}>
          <button
            type="button"
            class="touch-target mt-2 w-full rounded border border-rule px-3 py-2 disabled:opacity-50"
            disabled={checking()}
            onClick={() => void scan()}
          >
            Scan a pairing code
          </button>
          <p class="mt-2 text-xs text-ink-3">
            Or run <code>ecr token new phone --qr</code> on the server and point
            the camera at it.
          </p>
        </Show>

        {/*
          The address, and a way to change it. A device is refused by the server
          it is actually talking to, so "not authorised" is also what a client
          aimed at somebody else's ecr would say — and pasting tokens into it
          forever is the one thing that cannot fix that.
        */}
        <button
          type="button"
          class="mt-3 block w-full truncate text-left text-xs text-ink-3 underline decoration-dotted hover:text-obligation"
          title={props.store.connection().baseUrl}
          onClick={() => {
            props.onClose();
            props.store.setAskingServer(true);
          }}
        >
          {props.store.connection().baseUrl || "no server url configured"} —
          change
        </button>

        <Show when={problem()}>
          {(reason) => (
            <p class="mt-2 text-xs break-words text-blocking" role="alert">
              {reason()}
            </p>
          )}
        </Show>
      </form>
    </div>
  );
}

/**
 * Nothing answered at the address this client is pointed at, and the only thing
 * that fixes it is another address.
 *
 * It lays over the client rather than replacing it because the reason may not be
 * the address at all — the server may simply not be running yet — and blanking a
 * client that still has a thread on screen to say so helps nobody. The address is
 * probed before it is kept, so a typo says so in the field it was typed in.
 *
 * This is reachable on every platform, which is the point: the browser resolves
 * its address from `location.origin` and the shell hands the desktop and the
 * phone one, so before this existed a client aimed at the wrong host had no way
 * of ever being aimed at the right one.
 */
export function ServerAlert(props: { store: AppStore; onClose: () => void }) {
  const [problem, setProblem] = createSignal("");
  const [checking, setChecking] = createSignal(false);
  let input: HTMLInputElement | undefined;

  async function scan() {
    setProblem("");
    setChecking(true);
    const reason = await props.store.pairByScanning();
    setChecking(false);
    setProblem(reason);
    if (reason === "") props.onClose();
  }

  onMount(() => {
    input?.focus();
    input?.select();
  });

  async function submit(event: Event) {
    event.preventDefault();
    setChecking(true);
    const reason = await props.store.reachServer(input?.value ?? "");
    setChecking(false);
    setProblem(reason);
    if (reason === "") props.onClose();
    else input?.focus();
  }

  return (
    <div
      class="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ecr-server-title"
      onClick={props.onClose}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        props.onClose();
      }}
    >
      <form
        class="w-full max-w-md rounded border border-blocking bg-paper-2 p-5"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
      >
        <h2 id="ecr-server-title" class="mb-1 text-base text-blocking">
          cannot reach the server
        </h2>
        <p class="mb-4 text-xs text-ink-3">
          Start it with <code>ecr serve</code> on the machine that holds the
          mail, then give the address it prints. From another device that is the
          machine's address on the network, not <code>localhost</code>.
        </p>

        <label class="mb-4 block">
          <span class="text-xs uppercase text-ink-3">Server address</span>
          <input
            ref={input}
            type="url"
            inputmode="url"
            autocapitalize="off"
            autocomplete="off"
            spellcheck={false}
            class="touch-target mono mt-1 w-full rounded px-2 py-1.5"
            value={props.store.connection().baseUrl}
            placeholder="http://your-host:8383"
            aria-label="Server address"
            aria-invalid={problem() !== ""}
          />
        </label>

        <button
          type="submit"
          class="touch-target w-full rounded bg-obligation px-3 py-2 font-semibold text-paper disabled:opacity-50"
          disabled={checking()}
        >
          {checking() ? "trying…" : "Connect"}
        </button>

        {/*
          A phone is where typing an address and a 64-character token hurts
          most, and is the only thing with a camera — so the scanner is offered
          only where it exists, rather than shown everywhere and refused.
        */}
        <Show when={canScanQr()}>
          <button
            type="button"
            class="touch-target mt-2 w-full rounded border border-rule px-3 py-2 disabled:opacity-50"
            disabled={checking()}
            onClick={() => void scan()}
          >
            Scan a pairing code
          </button>
          <p class="mt-2 text-xs text-ink-3">
            Run <code>ecr token new phone --qr --url http://your-host:8383</code>{" "}
            on the server and point the camera at it.
          </p>
        </Show>

        <Show when={problem()}>
          {(reason) => (
            <p class="mt-3 text-xs break-words text-blocking" role="alert">
              {reason()}
            </p>
          )}
        </Show>
      </form>
    </div>
  );
}

/**
 * `ecr doctor`, as the server itself reports it.
 *
 * The server refuses to start unless its setup is healthy, so what reaches here
 * are the warnings it started anyway with — an expired OAuth token, a `post-new`
 * hook that is not wired up, a notmuch missing `index.header.List`. Every one of
 * them is otherwise experienced as mail that quietly does not arrive, or a
 * sidebar section that is quietly empty, with nothing connecting the symptom to
 * the cause. Each check carries the doctor's own hint, so the fix is named here
 * rather than left to be searched for.
 */
export function DoctorAlert(props: { store: AppStore; onClose: () => void }) {
  const report = () => props.store.health();

  return (
    <div
      class="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ecr-doctor-title"
      onClick={props.onClose}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        props.onClose();
      }}
    >
      <div
        class="max-h-full w-full max-w-lg overflow-y-auto rounded border border-rule bg-paper-2 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="ecr-doctor-title" class="mb-1 text-base text-obligation">
          the server's mail setup
        </h2>
        <p class="mb-4 text-xs text-ink-3">
          What <code>ecr doctor</code> reports on the machine holding the mail.
          These are fixed there, not here.
        </p>

        <Show
          when={props.store.serverChecks().length > 0}
          fallback={<p class="text-xs text-proved">every check passed.</p>}
        >
          <ul class="mb-4 flex flex-col gap-3">
            <For each={props.store.serverChecks()}>
              {(check) => (
                <li>
                  <p
                    class="text-sm"
                    classList={{
                      "text-blocking": check.status === "fail",
                      "text-obligation": check.status === "warn",
                    }}
                  >
                    {check.status === "fail" ? "✗" : "!"} {check.name}
                  </p>
                  <p class="text-xs break-words text-ink-2">{check.detail}</p>
                  <Show when={check.hint}>
                    {(hint) => (
                      <p class="mono mt-0.5 text-xs break-words text-ink-3">
                        {hint()}
                      </p>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <dl class="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-1 border-t border-rule pt-3 text-xs">
          <dt class="text-ink-3">maildir</dt>
          <dd class="mono break-words text-ink-2">
            {report()?.maildir_root ?? "—"}
          </dd>
          <dt class="text-ink-3">database</dt>
          <dd class="mono break-words text-ink-2">
            {report()?.database_path ?? "—"}
          </dd>
          <dt class="text-ink-3">accounts</dt>
          <dd class="text-ink-2">{report()?.accounts.length ?? 0}</dd>
        </dl>

        <button
          type="button"
          class="touch-target mt-4 w-full rounded border border-rule px-3 py-2 text-obligation hover:bg-neutral-bg"
          onClick={() => props.store.retryServer()}
        >
          check again
        </button>
      </div>
    </div>
  );
}

/**
 * The first run, before any address is known — the desktop and the phone both
 * arrive here if the shell has no URL to hand over. Unlike the dialog above
 * there is nothing behind it to lay over, so it takes the pane.
 *
 * It goes through the same probe, so an address is proved here too rather than
 * saved and discovered to be wrong one empty pane later.
 */
export function ConnectionSetup(props: { store: AppStore }) {
  const [problem, setProblem] = createSignal("");
  const [checking, setChecking] = createSignal(false);
  let urlInput: HTMLInputElement | undefined;

  onMount(() => urlInput?.focus());

  async function submit(event: Event) {
    event.preventDefault();
    setChecking(true);
    setProblem(await props.store.reachServer(urlInput?.value ?? ""));
    setChecking(false);
  }

  async function scan() {
    setProblem("");
    setChecking(true);
    setProblem(await props.store.pairByScanning());
    setChecking(false);
  }

  return (
    <div class="chrome-sides flex h-full items-center justify-center p-6">
      <form
        class="w-full max-w-md rounded border border-rule bg-paper-2 p-5"
        onSubmit={(e) => void submit(e)}
      >
        <h1 class="mb-1 text-base text-obligation">Connect to ecr-server</h1>
        <p class="mb-4 text-xs text-ink-3">
          Run <code>ecr serve</code> on the machine that holds the mail and give
          the address it prints. The token comes after, once the server has been
          reached.
        </p>

        <label class="mb-4 block">
          <span class="text-xs uppercase text-ink-3">Server address</span>
          <input
            ref={urlInput}
            type="url"
            inputmode="url"
            autocapitalize="off"
            autocomplete="off"
            spellcheck={false}
            class="touch-target mono mt-1 w-full rounded px-2 py-1.5"
            value={props.store.connection().baseUrl}
            placeholder="http://your-host:8383"
            aria-label="Server address"
            aria-invalid={problem() !== ""}
          />
        </label>

        <button
          type="submit"
          class="touch-target w-full rounded bg-obligation px-3 py-2 font-semibold text-paper disabled:opacity-50"
          disabled={checking()}
        >
          {checking() ? "trying…" : "Connect"}
        </button>

        {/*
          A phone is where typing an address and a 64-character token hurts
          most, and is the only thing with a camera — so the scanner is offered
          only where it exists, rather than shown everywhere and refused.
        */}
        <Show when={canScanQr()}>
          <button
            type="button"
            class="touch-target mt-2 w-full rounded border border-rule px-3 py-2 disabled:opacity-50"
            disabled={checking()}
            onClick={() => void scan()}
          >
            Scan a pairing code
          </button>
          <p class="mt-2 text-xs text-ink-3">
            Run <code>ecr token new phone --qr --url http://your-host:8383</code>{" "}
            on the server and point the camera at it.
          </p>
        </Show>

        <Show when={problem()}>
          {(reason) => (
            <p class="mt-3 text-xs break-words text-blocking" role="alert">
              {reason()}
            </p>
          )}
        </Show>
      </form>
    </div>
  );
}
