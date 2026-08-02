import { For, Show, createSignal } from "solid-js";
import type { Attachment, Draft } from "../api/types";
import type { AppStore } from "../state/store";
import { formatSize, refuseReason, toAttachment } from "../state/attachments";
import { VimEditor, type VimEditorProps } from "./VimEditor";
import { PlainEditor } from "./PlainEditor";
import { isNarrow } from "./narrow";

/**
 * Which editor a surface gets. A phone has no way out of normal mode and no
 * reason to want one, so it writes in a plain textarea; everywhere else the
 * vim editor is the point of the client.
 */
function Editor(props: VimEditorProps) {
  return isNarrow() ? <PlainEditor {...props} /> : <VimEditor {...props} />;
}

export function emptyDraft(): Draft {
  return {
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "",
    in_reply_to: null,
    references: [],
    attachments: [],
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

/** The header rows, in the order Tab walks them. */
export const FIELDS = ["to", "cc", "bcc", "subject"] as const;
export type Field = (typeof FIELDS)[number] | "body";
const ORDER: Field[] = [...FIELDS, "body"];

export function nextField(current: Field, delta: number): Field {
  const at = ORDER.indexOf(current);
  return ORDER[(at + delta + ORDER.length) % ORDER.length]!;
}

/**
 * Headers are rows, not text: the labels are DOM, so `To:` cannot be edited
 * away or typed over. Every value is still the same vim engine as the body —
 * one line each — so `ciw` on a recipient works exactly as it does anywhere
 * else, and Tab walks the rows.
 */
export function ComposePane(props: {
  store: AppStore;
  draft: Draft;
  label: string;
  onClose: () => void;
}) {
  const [error, setError] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [focus, setFocus] = createSignal<Field>(
    props.draft.to.length > 0 ? "body" : "to",
  );

  const [values, setValues] = createSignal({
    to: formatRecipients(props.draft.to),
    cc: formatRecipients(props.draft.cc),
    bcc: formatRecipients(props.draft.bcc),
    subject: props.draft.subject,
    body: props.draft.body,
  });

  const [attachments, setAttachments] = createSignal<Attachment[]>(
    props.draft.attachments ?? [],
  );

  let picker: HTMLInputElement | undefined;

  const account = () => props.store.sendingAccount();

  const set = (field: Field, value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  const collected = (): Draft => ({
    ...props.draft,
    to: parseRecipients(values().to),
    cc: parseRecipients(values().cc),
    bcc: parseRecipients(values().bcc),
    subject: values().subject,
    body: values().body,
    attachments: attachments(),
  });

  const attach = async (files: File[]) => {
    for (const file of files) {
      const refusal = refuseReason(attachments(), file.size);
      if (refusal) {
        setError(`${file.name}: ${refusal}`);
        continue;
      }
      const attachment = await toAttachment(file);
      setAttachments((current) => [...current, attachment]);
      setError("");
    }
  };

  const submit = async () => {
    const draft = collected();

    if (draft.to.length === 0 && draft.cc.length === 0 && draft.bcc.length === 0) {
      setError("add at least one recipient before sending");
      setFocus("to");
      return;
    }

    setSending(true);
    setError("");
    const ok = await props.store.send(draft);
    setSending(false);
    if (ok) props.onClose();
    else setError(props.store.status());
  };

  const shared = (field: Field) => ({
    onSubmit: () => void submit(),
    onCancel: props.onClose,
    onChange: (text: string) => set(field, text),
    onNextField: () => setFocus(nextField(field, 1)),
    onPreviousField: () => setFocus(nextField(field, -1)),
    onCommand: (command: string) => {
      if (command === "attach" || command === "a") picker?.click();
      else setError(`unknown command: ${command}`);
    },
    onPasteFiles: (files: File[]) => void attach(files),
  });

  return (
    <div
      class="flex min-h-0 flex-1 flex-col"
      classList={{ "ring-2 ring-obligation": dragging() }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void attach([...(e.dataTransfer?.files ?? [])]);
      }}
    >
      <header class="flex shrink-0 items-start gap-3 border-b border-rule bg-paper-2 px-4 py-2">
        <div class="min-w-0 flex-1">
          <h1 class="text-sm text-ink">{props.label}</h1>
          <div class="text-xs text-ink-3">
            from {account()?.address ?? "no account"}
            {/* Keys only where there are keys; the buttons beside this do the
                same three things on a phone. */}
            <span class="hidden md:inline">
              {" · "}
              <kbd>Tab</kbd> field · <kbd>ZZ</kbd> send · <kbd>ZQ</kbd> discard ·{" "}
              <kbd>C-b</kbd> hide
            </span>
          </div>
        </div>

        {/* ZZ sends on a desktop. A thumb needs somewhere to press. */}
        <button
          type="button"
          class="touch-target shrink-0 rounded bg-obligation px-3 py-1 text-xs font-semibold text-paper md:hidden"
          onClick={() => void submit()}
        >
          Send
        </button>

        <button
          type="button"
          class="touch-target shrink-0 rounded border border-rule px-2 py-0.5 text-xs text-ink-2 hover:bg-neutral-bg"
          onClick={props.onClose}
          title="Discard (ZQ)"
          aria-label="Discard"
        >
          ✕
        </button>
      </header>

      <div class="shrink-0 border-b border-rule">
        <For each={FIELDS}>
          {(field) => (
            <div
              class="flex items-center gap-2 border-b border-rule-soft px-3 last:border-b-0"
              classList={{ "bg-neutral-bg/40": focus() === field }}
              onClick={() => setFocus(field)}
            >
              {/* A label, not text in the buffer: there is nothing here to edit. */}
              <span class="w-14 shrink-0 text-xs uppercase tracking-wide text-ink-3">
                {field}
              </span>
              <div class="min-w-0 flex-1">
                <Editor
                  initial={values()[field]}
                  label={`${field} field`}
                  singleLine
                  startMode={props.store.settings().preferences.editorStartMode}
                  addressBook={field === "subject" ? undefined : props.store.addressBook() ?? []}
                  {...shared(field)}
                  focused={focus() === field}
                />
              </div>
            </div>
          )}
        </For>
      </div>

      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule px-3 py-1.5">
        <For each={attachments()}>
          {(attachment, index) => (
            <span class="flex items-center gap-1 rounded border border-rule bg-card px-2 py-0.5 text-xs">
              <span class="truncate-cell max-w-40">{attachment.filename}</span>
              <span class="mono text-ink-3">{formatSize(attachment.data_b64.length)}</span>
              <button
                type="button"
                class="text-ink-3 hover:text-blocking"
                aria-label={`Remove ${attachment.filename}`}
                onClick={() =>
                  setAttachments((current) => current.filter((_, i) => i !== index()))
                }
              >
                ✕
              </button>
            </span>
          )}
        </For>

        <button
          type="button"
          class="rounded border border-rule px-2 py-0.5 text-xs text-obligation hover:bg-neutral-bg"
          onClick={() => picker?.click()}
          title="Attach a file (:attach), or drop one here"
        >
          ＋ attach
        </button>

        <span class="text-xs text-ink-3">or drop files here</span>

        <input
          ref={picker}
          type="file"
          multiple
          class="hidden"
          onChange={(e) => {
            void attach([...(e.currentTarget.files ?? [])]);
            e.currentTarget.value = "";
          }}
        />
      </div>

      <Show when={error()}>
        <p class="shrink-0 border-b border-blocking bg-blocking-bg px-4 py-2 text-xs text-blocking">
          {error()}
        </p>
      </Show>

      <Show when={sending()}>
        <p class="shrink-0 border-b border-rule px-4 py-2 text-xs text-ink-3">sending…</p>
      </Show>

      <Editor
        initial={values().body}
        label={props.label}
        submitLabel="send"
        startMode={props.store.settings().preferences.editorStartMode}
        onModeChange={(mode) => props.store.setMode(mode === "insert" ? "insert" : "normal")}
        {...shared("body")}
        focused={focus() === "body"}
      />
    </div>
  );
}
