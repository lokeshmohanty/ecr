import { describe, expect, it } from "vitest";
import { markToOps, DEFAULT_VIEWS, MARK_TAGS } from "./store";

describe("mark queue to tag operations", () => {
  it("turns an archive mark into removing inbox", () => {
    expect(markToOps({ "a@x": ["archive"] })).toEqual([
      { id: "a@x", add: [], remove: ["inbox"] },
    ]);
  });

  it("turns a delete mark into deleted plus removing inbox", () => {
    const [op] = markToOps({ "a@x": ["delete"] });
    expect(op!.add).toEqual(["deleted"]);
    expect(op!.remove).toEqual(["inbox"]);
  });

  it("batches several messages into one operation list", () => {
    const ops = markToOps({ "a@x": ["archive"], "b@x": ["flag"] });
    expect(ops).toHaveLength(2);
    expect(ops.map((o) => o.id).sort()).toEqual(["a@x", "b@x"]);
  });

  it("merges several marks on the same message", () => {
    const [op] = markToOps({ "a@x": ["archive", "read"] });
    expect(op!.remove.sort()).toEqual(["inbox", "unread"]);
  });

  it("never both adds and removes the same tag", () => {
    const [op] = markToOps({ "a@x": ["read", "unread"] });
    expect(op!.add).toEqual(["unread"]);
    expect(op!.remove).not.toContain("unread");
  });

  it("drops messages whose marks cancel out to nothing", () => {
    expect(markToOps({ "a@x": [] })).toEqual([]);
  });

  it("produces nothing for an empty queue", () => {
    expect(markToOps({})).toEqual([]);
  });
});

describe("mark badges", () => {
  it("gives every mark a single-character badge", () => {
    for (const [mark, spec] of Object.entries(MARK_TAGS)) {
      expect(spec.badge, mark).toHaveLength(1);
    }
  });
});

describe("default views", () => {
  it("every view has a non-empty notmuch query", () => {
    for (const view of DEFAULT_VIEWS) {
      expect(view.query.trim(), view.name).not.toBe("");
    }
  });

  it("inbox is first so it is the landing view", () => {
    expect(DEFAULT_VIEWS[0]!.name).toBe("INBOX");
    expect(DEFAULT_VIEWS[0]!.query).toBe("tag:inbox");
  });

  it("view names are unique", () => {
    const names = DEFAULT_VIEWS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
