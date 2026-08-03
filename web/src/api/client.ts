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
} from "./types";

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

function defaultBaseUrl(): string {
  // Served by the ecr server itself, so the API is on this very origin. This is
  // what makes opening http://host:8383 work with nothing to configure.
  if (typeof location !== "undefined" && location.protocol.startsWith("http")) {
    return location.origin;
  }
  // Under Tauri the origin is tauri://localhost; the real URL comes from the
  // shell asynchronously, so this is only a placeholder until it answers.
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

  send(account: string, draft: Draft): Promise<{ bytes: number; account: string }> {
    return this.request("/api/v1/send", {
      method: "POST",
      body: JSON.stringify({ account, ...draft }),
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
