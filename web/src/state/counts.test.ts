import { describe, expect, it, vi } from "vitest";

import { createCounts } from "./counts";

/**
 * A harness with a hand-cranked clock. The debounce is the whole point of this
 * module, so the scheduler has to be controllable rather than immediate —
 * running the callback synchronously would flush before the next request could
 * possibly join the batch, and coalescing could never be observed.
 */
function harness(answer: (queries: string[]) => Promise<number[]>) {
  const store = new Map<string, number>();
  const asked: string[][] = [];
  let queued: (() => void) | null = null;

  const cache = createCounts(
    {
      counts: (queries) => {
        asked.push([...queries]);
        return answer(queries);
      },
    },
    (entries) => {
      for (const [query, count] of entries) store.set(query, count);
    },
    (query) => store.get(query),
    () => store.clear(),
    {
      debounceMs: 0,
      schedule: (run) => {
        queued = run;
        return 1;
      },
      cancel: () => {
        queued = null;
      },
    },
  );

  /** Fires the pending debounce, then lets the request's promise settle. */
  const tick = async () => {
    const run = queued;
    queued = null;
    run?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  return { cache, asked, store, tick };
}

const numbering = (queries: string[]) => Promise.resolve(queries.map((_, i) => i + 1));

describe("createCounts", () => {
  it("answers each query with the count at its own index", async () => {
    const { cache, store, tick } = harness(numbering);

    cache.request(["tag:inbox", "tag:unread", "tag:flagged"]);
    await tick();

    expect(store.get("tag:inbox")).toBe(1);
    expect(store.get("tag:unread")).toBe(2);
    expect(store.get("tag:flagged")).toBe(3);
  });

  it("sends one request for everything asked before the debounce fires", async () => {
    const { cache, asked, tick } = harness(numbering);

    cache.request(["a"]);
    cache.request(["b", "c"]);
    await tick();

    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual(["a", "b", "c"]);
  });

  it("does not ask again for a count it already has", async () => {
    const { cache, asked, tick } = harness(numbering);

    cache.request(["a", "b"]);
    await tick();
    cache.request(["a", "b"]);
    await tick();

    expect(asked).toHaveLength(1);
  });

  it("never asks for a blank query, which would count the whole database", async () => {
    const { cache, asked, tick } = harness(numbering);

    cache.request(["", "   ", "tag:inbox"]);
    await tick();

    expect(asked[0]).toEqual(["tag:inbox"]);
  });

  it("does not ask twice for a query already in flight", async () => {
    let release: (counts: number[]) => void = () => {};
    const { cache, asked, tick } = harness(
      () => new Promise<number[]>((resolve) => (release = resolve)),
    );

    cache.request(["a"]);
    await tick();
    cache.request(["a"]);
    await tick();

    expect(asked).toHaveLength(1);
    release([7]);
  });

  it("refetches after an invalidate", async () => {
    const { cache, asked, store, tick } = harness(numbering);

    cache.request(["a"]);
    await tick();
    expect(store.get("a")).toBe(1);

    cache.invalidate();
    expect(store.get("a")).toBeUndefined();

    cache.request(["a"]);
    await tick();
    expect(asked).toHaveLength(2);
  });

  it("reports a failure rather than throwing into the render", async () => {
    const onError = vi.fn();
    const store = new Map<string, number>();
    const queued: { run: (() => void) | null } = { run: null };
    const cache = createCounts(
      { counts: () => Promise.reject(new Error("offline")) },
      (entries) => {
        for (const [q, c] of entries) store.set(q, c);
      },
      (q) => store.get(q),
      () => store.clear(),
      {
        debounceMs: 0,
        schedule: (run) => ((queued.run = run), 1),
        cancel: () => {},
        onError,
      },
    );

    cache.request(["a"]);
    queued.run?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalled();
    expect(store.get("a")).toBeUndefined();
  });

  it("a query that failed can be asked again", async () => {
    let fail = true;
    const { cache, asked, tick } = harness((queries) =>
      fail ? Promise.reject(new Error("offline")) : Promise.resolve(queries.map(() => 4)),
    );

    cache.request(["a"]);
    await tick();

    fail = false;
    cache.request(["a"]);
    await tick();

    expect(asked).toHaveLength(2);
  });
});
