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

export interface Body {
  format: "text" | "html";
  content: string;
  remote_resources_blocked: number;
  /** Whether the message has a real HTML part to switch to. */
  has_html: boolean;
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
