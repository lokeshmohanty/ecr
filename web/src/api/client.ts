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
  if (typeof location !== "undefined" && location.protocol.startsWith("http")) {
    return location.origin;
  }
  return "http://localhost:8080";
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
      throw new ApiError(response.status, code, detail);
    }

    return (await response.json()) as T;
  }

  health(): Promise<Doctor> {
    return this.request("/api/v1/health");
  }

  revision(): Promise<Revision> {
    return this.request("/api/v1/revision");
  }

  accounts(): Promise<Account[]> {
    return this.request("/api/v1/accounts");
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

  body(id: string, html: boolean, remote: boolean): Promise<Body> {
    const params = new URLSearchParams({ html: String(html), remote: String(remote) });
    return this.request(`/api/v1/messages/${encodeURIComponent(id)}/body?${params}`);
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
    const source = new EventSource(this.url(`/api/v1/events?access_token=${token}`));

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
