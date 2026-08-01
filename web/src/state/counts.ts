/**
 * Counts for whatever the sidebar is currently showing.
 *
 * Only rendered rows are asked about: the sidebar expands one group at a time,
 * so this is tens of queries rather than every view of every account. Requests
 * are coalesced, because a revision bump and a navigation usually land together
 * and each would otherwise cost its own round trip.
 */
export interface CountsSource {
  counts(queries: string[]): Promise<number[]>;
}

export interface CountsCache {
  /** The last known count for a query, or undefined until one arrives. */
  get(query: string): number | undefined;
  /** Asks for anything in `queries` that is missing or stale. */
  request(queries: string[]): void;
  /** Drops every count, so the next request refetches. Call on a revision bump. */
  invalidate(): void;
}

export interface CountsOptions {
  /** How long to wait for more queries before sending. */
  debounceMs?: number;
  onError?: (error: unknown) => void;
  schedule?: (run: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
}

/**
 * `store` receives a whole response at once rather than a value at a time: the
 * results have to land in a single update, or a reader tracking a query that
 * had no count yet is not reliably woken when one arrives.
 */
export function createCounts(
  source: CountsSource,
  store: (entries: [string, number][]) => void,
  read: (query: string) => number | undefined,
  clear: () => void,
  options: CountsOptions = {},
): CountsCache {
  const debounceMs = options.debounceMs ?? 60;
  const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms) as unknown as number);
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle));

  let pending = new Set<string>();
  let inFlight = new Set<string>();
  let handle: number | null = null;
  // Tracked separately from the handle: a scheduler that runs the callback
  // synchronously would otherwise leave a stale handle behind and the guard
  // below would refuse every later request.
  let scheduled = false;

  function flush(): void {
    scheduled = false;
    handle = null;
    const queries = [...pending].filter((q) => !inFlight.has(q));
    pending = new Set();
    if (queries.length === 0) return;

    for (const query of queries) inFlight.add(query);

    void source
      .counts(queries)
      .then((counts) => {
        const entries: [string, number][] = [];
        queries.forEach((query, index) => {
          const count = counts[index];
          if (typeof count === "number") entries.push([query, count]);
        });
        if (entries.length > 0) store(entries);
      })
      .catch((error) => options.onError?.(error))
      .finally(() => {
        for (const query of queries) inFlight.delete(query);
      });
  }

  return {
    get: read,
    request(queries) {
      let added = false;
      for (const query of queries) {
        const trimmed = query.trim();
        // A blank query would count the whole database, and an in-flight one is
        // already on its way.
        if (trimmed === "" || inFlight.has(trimmed)) continue;
        if (read(trimmed) !== undefined) continue;
        pending.add(trimmed);
        added = true;
      }
      if (!added || scheduled) return;
      scheduled = true;
      handle = schedule(flush, debounceMs);
    },
    invalidate() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      scheduled = false;
      pending = new Set();
      // In-flight answers describe the database before the change, so they are
      // abandoned rather than written over the fresh state.
      inFlight = new Set();
      clear();
    },
  };
}
