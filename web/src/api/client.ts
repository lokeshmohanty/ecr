import type {
  Account,
  Body,
  Doctor,
  Draft,
  Message,
  Page,
  Revision,
  ServerEvent,
  SyncReport,
  TagOp,
  Thread,
  ThreadSummary,
  ThemeListing,
  MailingLists,
  AuthorizeStarted,
  ManagedAccount,
  ManagedRule,
  MailFolder,
  ManagedView,
  OutboxEntry,
  RsvpAnswer,
} from "./types";
import { isTauri } from "./platform";

export interface Connection {
  baseUrl: string;
  token: string;
}

const STORAGE_KEY = "ecr.connection";

export function loadConnection(): Connection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Connection;
  } catch {
    // fall through to the default
  }
  return { baseUrl: defaultBaseUrl(), token: "" };
}

export function saveConnection(connection: Connection): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
}

/**
 * Where a client that has never been given an address starts.
 *
 * Only ever consulted when nothing is stored: an address a device was paired
 * with outranks every default, which is what the shell answering with one broke
 * on Android.
 */
function defaultBaseUrl(): string {
  // A shell's origin is its own — `tauri://localhost` on the desktop but
  // `http://tauri.localhost` on Android, which the origin check below would
  // otherwise take for a server and hand back the webview's own address. The
  // shell only names a server when one was configured through ECR_SERVER_URL,
  // so this is the starting point: the machine the app is running on, which is
  // where a desktop install's server is and is merely unreachable on a phone —
  // where nothing else is known yet and the pairing prompt opens by itself.
  if (isTauri()) return "http://localhost:8383";
  // Served by the ecr server itself, so the API is on this very origin. This is
  // what makes opening http://host:8383 work with nothing to configure.
  if (typeof location !== "undefined" && location.protocol.startsWith("http")) {
    return location.origin;
  }
  return "";
}

export function hasConnection(connection: Connection): boolean {
  return connection.baseUrl.trim() !== "";
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(detail);
    this.name = "ApiError";
  }

  get isAuth(): boolean {
    return this.status === 401;
  }
}

export class Api {
  constructor(private connection: Connection) {}

  private refused: (() => void) | null = null;

  /**
   * Called whenever the server refuses this device. Every request goes through
   * one place, and most callers swallow their errors to keep a pane quiet, so
   * this is the only point at which a missing or revoked token is still visible.
   */
  onUnauthorized(handler: () => void): void {
    this.refused = handler;
  }

  update(connection: Connection): void {
    this.connection = connection;
  }

  get baseUrl(): string {
    return this.connection.baseUrl.replace(/\/$/, "");
  }

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  partUrl(messageId: string, part: number): string {
    const token = encodeURIComponent(this.connection.token);
    return this.url(
      `/api/v1/messages/${encodeURIComponent(messageId)}/parts/${part}?access_token=${token}`,
    );
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.connection.token) {
      headers.set("authorization", `Bearer ${this.connection.token}`);
    }
    if (init.body) headers.set("content-type", "application/json");

    const response = await fetch(this.url(path), { ...init, headers });

    if (!response.ok) {
      let code = "http_error";
      let detail = response.statusText;
      try {
        const body = await response.json();
        code = body.error ?? code;
        detail = body.detail ?? detail;
      } catch {
        // keep the status text
      }
      if (response.status === 401) this.refused?.();
      throw new ApiError(response.status, code, detail);
    }

    return (await response.json()) as T;
  }

  /**
   * Whether the server accepts this token, without adopting it first — a token
   * saved before it is known to work leaves every pane empty with nothing left
   * on screen to say why. Checked against a protected route: `/api/v1/health`
   * is public and answers the same for a token that is worthless.
   */
  async accepts(token: string): Promise<boolean> {
    const response = await fetch(this.url("/api/v1/revision"), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 401) return false;
    if (!response.ok) {
      throw new ApiError(response.status, "http_error", response.statusText);
    }
    return true;
  }

  /**
   * The server's own account of itself, asked at the one route that is public.
   *
   * That is what makes it the probe for whether an address is a server at all.
   * Every other route answers 401 for a device that has not been paired, so
   * without this "nothing is listening there" and "you are not authorised here"
   * arrive as the same silence — and they have entirely different fixes, one in
   * the address field and one in the token field.
   *
   * Takes the address rather than reading it, so a URL can be tried before it is
   * adopted: a client pointed at the wrong host to find out is a client with no
   * way back to the one that worked.
   */
  async probe(baseUrl?: string): Promise<Doctor> {
    const base = (baseUrl ?? this.baseUrl).replace(/\/$/, "");
    const response = await fetch(`${base}/api/v1/health`);
    if (!response.ok) {
      throw new ApiError(response.status, "http_error", response.statusText);
    }
    return (await response.json()) as Doctor;
  }

  revision(): Promise<Revision> {
    return this.request("/api/v1/revision");
  }

  accounts(): Promise<Account[]> {
    return this.request("/api/v1/accounts");
  }

  addresses(): Promise<{ name: string | null; email: string; source: string; count: number }[]> {
    return this.request("/api/v1/addresses");
  }

  tags(): Promise<string[]> {
    return this.request("/api/v1/tags");
  }

  threads(query: string, limit = 100, offset = 0): Promise<Page<ThreadSummary>> {
    const params = new URLSearchParams({
      q: query,
      limit: String(limit),
      offset: String(offset),
    });
    return this.request(`/api/v1/threads?${params}`);
  }

  thread(id: string): Promise<Thread> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}`);
  }

  message(id: string): Promise<Message> {
    return this.request(`/api/v1/messages/${encodeURIComponent(id)}`);
  }

  /**
   * Bodies are cached in memory. A message's content never changes — a new
   * message is a new file — so revisiting one should not cost a round trip.
   * This is what makes walking a list with j/k feel instant on the way back.
   */
  private bodies = new Map<string, Body>();

  async config(): Promise<{ path: string; raw: string }> {
    return await this.request("/api/v1/config");
  }

  async saveConfig(raw: string): Promise<void> {
    await this.request("/api/v1/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw }),
    });
  }

  async lists(): Promise<MailingLists> {
    return await this.request("/api/v1/lists");
  }

  /** Positional: `counts[i]` answers `queries[i]`. */
  async counts(queries: string[]): Promise<number[]> {
    if (queries.length === 0) return [];
    const body = await this.request<{ counts: number[] }>("/api/v1/counts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries }),
    });
    return body.counts;
  }

  /**
   * Answers an invitation.
   *
   * The calendar is rebuilt on the server from the message being answered: an
   * organiser matches a reply by its UID and SEQUENCE, and letting a client
   * name those would let it answer for an event it was never sent.
   */
  async folders(): Promise<MailFolder[]> {
    return await this.request("/api/v1/folders");
  }

  /**
   * Moves a message into a folder.
   *
   * A move is a maildir rename, so this is the one client call that relocates
   * the only copy of something — the server refuses a destination that is not
   * already a folder rather than creating one from a typo.
   */
  async moveMessage(id: string, folder: string): Promise<void> {
    await this.request(`/api/v1/messages/${encodeURIComponent(id)}/move`, {
      method: "POST",
      body: JSON.stringify({ folder }),
    });
  }

  async outbox(): Promise<OutboxEntry[]> {
    return await this.request("/api/v1/outbox");
  }

  /** Takes a message back before it goes. This is undo-send. */
  async unsend(id: string): Promise<void> {
    await this.request(`/api/v1/outbox/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async rsvp(
    messageId: string,
    account: string,
    answer: RsvpAnswer,
  ): Promise<void> {
    await this.request(
      `/api/v1/messages/${encodeURIComponent(messageId)}/rsvp`,
      { method: "POST", body: JSON.stringify({ account, answer }) },
    );
  }

  async managed(): Promise<ManagedView> {
    return await this.request("/api/v1/managed");
  }

  /**
   * Every write here answers with the whole view, because each one regenerates
   * the configuration files as a side effect — an account saved and not applied
   * is one the mail tools cannot see, and the client would have no way to tell.
   */
  async addManagedAccount(
    id: string,
    account: ManagedAccount,
  ): Promise<ManagedView> {
    return await this.request("/api/v1/managed/accounts", {
      method: "POST",
      body: JSON.stringify({ id, ...account }),
    });
  }

  async updateManagedAccount(
    id: string,
    account: ManagedAccount,
  ): Promise<ManagedView> {
    return await this.request(
      `/api/v1/managed/accounts/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify({ id, ...account }) },
    );
  }

  /**
   * Starts an OAuth flow for one account and answers with the URL to consent at.
   *
   * The flow outlives this request — it does not finish until somebody has
   * clicked through a consent screen — so this returns as soon as there is a URL
   * and the page watches `auth[id].token` in the view for it to become valid.
   * The server refuses this outright unless the caller is on its own machine.
   */
  async authorizeAccount(
    id: string,
    withDav: boolean,
  ): Promise<AuthorizeStarted> {
    return await this.request(
      `/api/v1/managed/accounts/${encodeURIComponent(id)}/authorize`,
      { method: "POST", body: JSON.stringify({ with_dav: withDav }) },
    );
  }

  /** Never deletes the mail; the maildir is left exactly where it is. */
  async removeManagedAccount(id: string): Promise<ManagedView> {
    return await this.request(
      `/api/v1/managed/accounts/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  async setManagement(
    pkg: string,
    management: "ecr" | "self",
  ): Promise<ManagedView> {
    return await this.request("/api/v1/managed/management", {
      method: "PUT",
      body: JSON.stringify({ package: pkg, management }),
    });
  }

  /**
   * Replaces the whole rule set.
   *
   * Whole rather than one at a time because order is part of what a rule set
   * means — they run top to bottom, and an earlier one that files a message
   * stops a later one from seeing it.
   */
  async setRules(rules: ManagedRule[]): Promise<ManagedView> {
    return await this.request("/api/v1/managed/rules", {
      method: "PUT",
      body: JSON.stringify({ rules }),
    });
  }

  async applyManaged(): Promise<ManagedView> {
    return await this.request("/api/v1/managed/apply", { method: "POST" });
  }

  async themes(): Promise<ThemeListing> {
    return await this.request("/api/v1/themes");
  }

  async theme(path: string): Promise<{ path: string; raw: string }> {
    return await this.request(`/api/v1/theme?${new URLSearchParams({ path })}`);
  }

  async saveTheme(path: string, raw: string): Promise<void> {
    await this.request("/api/v1/theme", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, raw }),
    });
  }

  async body(id: string, html: boolean, remote: boolean): Promise<Body> {
    const key = `${id}|${html}|${remote}`;
    const cached = this.bodies.get(key);
    if (cached) return cached;

    const body = await this.request<Body>(
      `/api/v1/messages/${encodeURIComponent(id)}/body?` +
        new URLSearchParams({ html: String(html), remote: String(remote) }),
    );

    // Bounded so a long session cannot grow without limit.
    if (this.bodies.size > 300) {
      const oldest = this.bodies.keys().next().value;
      if (oldest) this.bodies.delete(oldest);
    }
    this.bodies.set(key, body);
    return body;
  }

  private threads_ = new Map<string, Thread>();

  async threadCached(id: string): Promise<Thread> {
    const cached = this.threads_.get(id);
    if (cached) return cached;

    const thread = await this.thread(id);
    if (this.threads_.size > 200) {
      const oldest = this.threads_.keys().next().value;
      if (oldest) this.threads_.delete(oldest);
    }
    this.threads_.set(id, thread);
    return thread;
  }

  /** Tagging changes a thread, so its cached copy has to go. */
  invalidate(): void {
    this.threads_.clear();
  }

  tag(ops: TagOp[]): Promise<Revision> {
    return this.request("/api/v1/tags", {
      method: "POST",
      body: JSON.stringify({ ops }),
    });
  }

  sync(accounts: string[] = []): Promise<SyncReport> {
    return this.request("/api/v1/sync", {
      method: "POST",
      body: JSON.stringify({ accounts }),
    });
  }

  /**
   * Queues a message.
   *
   * Nothing is delivered synchronously any more: every send waits a few seconds
   * in the outbox first, which is what makes undo the default rather than a
   * feature somebody has to find. `at` is send-later, in unix seconds; `hold: 0`
   * skips the wait.
   */
  send(
    account: string,
    draft: Draft,
    options: { hold?: number; at?: number } = {},
  ): Promise<{
    bytes: number;
    account: string;
    queued?: string;
    due?: number;
  }> {
    return this.request("/api/v1/send", {
      method: "POST",
      body: JSON.stringify({ account, ...draft, ...options }),
    });
  }

  /** EventSource cannot set headers, so the token rides in the query string. */
  events(onEvent: (event: ServerEvent) => void, onError?: () => void): () => void {
    const token = encodeURIComponent(this.connection.token);

    let source: EventSource;
    try {
      source = new EventSource(this.url(`/api/v1/events?access_token=${token}`));
    } catch {
      // A relative URL is not constructible under tauri://; report it as a
      // disconnection rather than letting the constructor throw.
      onError?.();
      return () => {};
    }

    const names = [
      "mail:changed",
      "tags:changed",
      "sync:started",
      "sync:progress",
      "sync:finished",
      "error",
    ];

    for (const name of names) {
      source.addEventListener(name, (event) => {
        try {
          onEvent(JSON.parse((event as MessageEvent).data) as ServerEvent);
        } catch {
          // a malformed frame is not worth tearing the stream down for
        }
      });
    }

    source.onerror = () => onError?.();
    return () => source.close();
  }
}
