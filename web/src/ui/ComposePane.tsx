import { Show, createSignal } from "solid-js";
import type { Draft } from "../api/types";
import type { AppStore } from "../state/store";
import { VimEditor } from "./VimEditor";

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

/**
 * The draft is edited as a whole message: headers on top, a blank line, then
 * the body. That keeps one editing surface rather than a form plus a textarea,
 * and it is the shape anyone who has used a mail client from a terminal
 * expects.
 */
export function draftToText(draft: Draft): string {
  const lines = [
    `To: ${formatRecipients(draft.to)}`,
    `Cc: ${formatRecipients(draft.cc)}`,
    `Subject: ${draft.subject}`,
    "",
    draft.body,
  ];
  return lines.join("\n");
}

export function draftFromText(text: string, base: Draft): Draft {
  const lines = text.split("\n");
  const blank = lines.findIndex((l) => l.trim() === "");
  const headerLines = blank === -1 ? lines : lines.slice(0, blank);
  const body = blank === -1 ? "" : lines.slice(blank + 1).join("\n");

  const draft: Draft = { ...base, to: [], cc: [], bcc: [], subject: "", body };

  for (const line of headerLines) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();

    if (name === "to") draft.to = parseRecipients(value);
    else if (name === "cc") draft.cc = parseRecipients(value);
    else if (name === "bcc") draft.bcc = parseRecipients(value);
    else if (name === "subject") draft.subject = value;
  }

  return draft;
}

export function ComposePane(props: {
  store: AppStore;
  draft: Draft;
  label: string;
  onClose: () => void;
}) {
  const [error, setError] = createSignal("");
  const [sending, setSending] = createSignal(false);

  const account = () => props.store.sendingAccount();

  const submit = async (text: string) => {
    const draft = draftFromText(text, props.draft);

    if (draft.to.length === 0 && draft.cc.length === 0 && draft.bcc.length === 0) {
      setError("add at least one recipient before sending");
      return;
    }

    setSending(true);
    setError("");
    const ok = await props.store.send(draft);
    setSending(false);
    if (ok) props.onClose();
    else setError(props.store.status());
  };

  return (
    <>
      <header class="shrink-0 border-b border-border px-4 py-3">
        <h1 class="text-base text-text-strong">{props.label}</h1>
        <div class="text-xs text-text-dim">
          from {account()?.address ?? "no account"} · headers above the blank line ·{" "}
          <kbd>ZZ</kbd> send · <kbd>ZQ</kbd> discard
        </div>
      </header>

      <Show when={error()}>
        <p class="shrink-0 border-b border-tag-urgent bg-bg-tag-urgent px-4 py-2 text-xs text-tag-urgent">
          {error()}
        </p>
      </Show>

      <Show when={sending()}>
        <p class="shrink-0 border-b border-border px-4 py-2 text-xs text-text-dim">sending…</p>
      </Show>

      <VimEditor
        initial={draftToText(props.draft)}
        label={props.label}
        submitLabel="send"
        onSubmit={(text) => void submit(text)}
        onCancel={props.onClose}
        onModeChange={(mode) => props.store.setMode(mode === "insert" ? "insert" : "normal")}
      />
    </>
  );
}
