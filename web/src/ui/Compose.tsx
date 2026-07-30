import { Show, createSignal } from "solid-js";
import type { Draft } from "../api/types";
import type { AppStore } from "../state/store";

export function emptyDraft(): Draft {
  return {
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "",
    in_reply_to: null,
    references: [],
  };
}

export function parseRecipients(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function formatRecipients(list: string[]): string {
  return list.join(", ");
}

export function Compose(props: {
  store: AppStore;
  draft: Draft;
  onClose: () => void;
}) {
  const [to, setTo] = createSignal(formatRecipients(props.draft.to));
  const [cc, setCc] = createSignal(formatRecipients(props.draft.cc));
  const [subject, setSubject] = createSignal(props.draft.subject);
  const [body, setBody] = createSignal(props.draft.body);
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal("");

  const account = () => props.store.accounts()?.[0];

  const send = async () => {
    const from = account();
    if (!from) {
      setError("no account available to send from");
      return;
    }

    setSending(true);
    setError("");
    try {
      await props.store.api.send(from.id, {
        ...props.draft,
        to: parseRecipients(to()),
        cc: parseRecipients(cc()),
        subject: subject(),
        body: body(),
      });
      props.store.setStatus("sent");
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "send failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <div class="absolute inset-0 z-20 flex items-start justify-center bg-black/60 p-4 sm:p-8">
      <div class="flex max-h-full w-full max-w-3xl flex-col rounded border border-border bg-bg-panel shadow-2xl">
        <header class="flex items-center justify-between border-b border-border px-4 py-2">
          <span class="uppercase tracking-wide text-text-dim">Compose</span>
          <span class="text-xs text-text-dim">{account()?.address ?? "no account"}</span>
        </header>

        <div class="flex-1 overflow-y-auto p-4">
          <Field label="To" value={to()} onInput={setTo} placeholder="a@example.com, b@example.com" />
          <Field label="Cc" value={cc()} onInput={setCc} />
          <Field label="Subject" value={subject()} onInput={setSubject} />

          <textarea
            class="mt-3 h-64 w-full resize-y rounded p-2"
            value={body()}
            onInput={(e) => setBody(e.currentTarget.value)}
            onFocus={() => props.store.setMode("insert")}
            onBlur={() => props.store.setMode("normal")}
          />

          <Show when={error()}>
            <p class="mt-2 rounded border border-tag-urgent bg-bg-tag-urgent px-2 py-1 text-tag-urgent">
              {error()}
            </p>
          </Show>
        </div>

        <footer class="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            class="touch-target rounded border border-border px-3 py-1.5 text-text-secondary hover:bg-bg-hover"
            onClick={props.onClose}
          >
            Discard
          </button>
          <button
            type="button"
            class="touch-target rounded bg-accent px-4 py-1.5 font-semibold text-bg-main disabled:opacity-50"
            disabled={sending()}
            onClick={send}
          >
            {sending() ? "Sending…" : "Send"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field(props: {
  label: string;
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label class="mb-2 grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2">
      <span class="text-xs uppercase text-text-dim">{props.label}</span>
      <input
        class="touch-target w-full rounded px-2 py-1.5"
        value={props.value}
        placeholder={props.placeholder}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
    </label>
  );
}
