export interface Revision {
  uuid: string;
  lastmod: number;
}

export interface Folder {
  name: string;
  relative_path: string;
  kind: "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "other";
}

export interface Account {
  id: string;
  display_name: string;
  maildir_path: string;
  address: string | null;
  mbsync_channel: string | null;
  msmtp_account: string | null;
  folders: Folder[];
}

export interface ThreadSummary {
  id: string;
  subject: string;
  authors: string[];
  timestamp: number;
  date_relative: string;
  matched: number;
  total: number;
  tags: string[];
  newest_message: string | null;
  /**
   * The first line or two of the newest matched message.
   *
   * Absent means the index has not read it yet, not that there is none — they
   * are filled in the background, so a row that has just arrived shows its
   * sender and subject and gains a preview a moment later. A message with no
   * text at all is an empty string, which renders as no preview and is correct.
   */
  snippet?: string;
}

export interface Address {
  name: string | null;
  email: string;
}

export interface PartMeta {
  id: number;
  content_type: string;
  filename: string | null;
  size: number;
  disposition: "inline" | "attachment";
  content_id: string | null;
}

export interface Message {
  id: string;
  thread_id: string;
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  reply_to: Address[];
  date: string;
  timestamp: number;
  tags: string[];
  in_reply_to: string | null;
  references: string[];
  parts: PartMeta[];
  excluded: boolean;
}

export interface Thread {
  id: string;
  subject: string;
  messages: Message[];
}

/**
 * A meeting an invitation is about.
 *
 * Times are as the sender wrote them, not parsed into instants — an invitation
 * shown at the wrong time is worse than one shown as the sender wrote it.
 */
export interface Invite {
  summary?: string;
  location?: string;
  description?: string;
  organizer?: string;
  attendees: string[];
  starts?: string;
  ends?: string;
  /** REQUEST, REPLY or CANCEL — an invitation and a cancellation look alike. */
  method?: string;
  recurring: boolean;
}

export interface Body {
  format: "text" | "html";
  content: string;
  remote_resources_blocked: number;
  /** Whether the message has a real HTML part to switch to. */
  has_html: boolean;
  /** The meeting this message is about, when it carries one. */
  invite?: Invite;
}

export interface Page<T> {
  revision: Revision;
  total: number;
  items: T[];
}

export interface TagOp {
  id: string;
  add: string[];
  remove: string[];
}

export interface SyncReport {
  channels: string[];
  new_messages: number;
  duration_ms: number;
  warnings: string[];
}

export interface Attachment {
  filename: string;
  content_type: string;
  /** Base64, travelling in the same request that sends the draft. */
  data_b64: string;
}

export interface Draft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  in_reply_to: string | null;
  references: string[];
  attachments: Attachment[];
}

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  hint: string | null;
}

export interface Doctor {
  tools: { name: string; path: string | null; version: string | null }[];
  maildir_root: string | null;
  database_path: string | null;
  accounts: Account[];
  checks: Check[];
}

export interface MailingList {
  /** The bare List-Id, which is what a `List:` query searches. */
  id: string;
  name: string;
  count: number;
}

export interface MailingLists {
  lists: MailingList[];
  /** False when notmuch has no `index.header.List`, making `List:` unsearchable. */
  searchable: boolean;
}

export interface ThemeEntry {
  /** The value that goes in settings.toml, relative to the config dir. */
  path: string;
  name: string;
  builtin: boolean;
}

export interface ThemeListing {
  dir: string;
  presets: ThemeEntry[];
}

export type ServerEvent =
  | { type: "mail_changed"; revision: Revision }
  | { type: "tags_changed"; revision: Revision; ids: string[] }
  | { type: "sync_started"; accounts: string[] }
  | { type: "sync_progress"; line: string }
  | { type: "sync_finished"; new_messages: number; revision: Revision }
  | { type: "error"; detail: string };

/**
 * The accounts ecr manages, when it is managing any.
 *
 * `managing` being empty is the ordinary state of a self-managed install, not
 * an error: the pane says so and offers to take over, and nothing else in the
 * client changes.
 */
export type ManagedProvider = "gmail" | "outlook" | "fastmail" | "generic";

export type ManagedTls = "implicit" | "starttls" | "none";

export interface ManagedEndpoint {
  host: string;
  port: number;
  tls: ManagedTls;
}

/**
 * A password command can only be set at a terminal — the server refuses one over
 * HTTP, because it is a command that server would run. The client shows it and
 * never offers to change it.
 */
export type ManagedAuth =
  | { kind: "oauth"; profile: string }
  | { kind: "command"; command: string[] };

export interface ManagedFolders {
  inbox?: string;
  sent?: string;
  drafts?: string;
  trash?: string;
  junk?: string;
  archive?: string;
}

export type ManagedSides = "none" | "near" | "far" | "both";

export interface ManagedAccount {
  address: string;
  name?: string;
  provider: ManagedProvider;
  auth: ManagedAuth;
  imap?: ManagedEndpoint;
  smtp?: ManagedEndpoint;
  folders?: ManagedFolders;
  patterns?: string[];
  create: ManagedSides;
  expunge: ManagedSides;
  remove: ManagedSides;
  certificate_file?: string;
  primary: boolean;
  enabled: boolean;
}

export interface ManagedFile {
  kind: string;
  path: string;
  /** `stale` means accounts.toml moved on; `edited` means somebody edited the file. */
  state: "current" | "missing" | "stale" | "edited";
}

export interface ManagedView {
  /** Which of notmuch/mbsync/msmtp ecr generates configuration for. */
  managing: string[];
  path: string;
  maildir: string | null;
  accounts: {
    maildir?: string;
    name?: string;
    exclude_tags: string[];
    account: Record<string, ManagedAccount>;
  };
  files: ManagedFile[];
  problems: string[];
}
