import { describe, expect, it } from "vitest";
import { entryAt, offsetsOf, windowRange, windowSlice } from "./window";

const ROW = 58;

describe("windowRange", () => {
  it("renders a screenful before the container is measured", () => {
    const range = windowRange(6, 0, 0, ROW);
    expect(range.start).toBe(0);
    expect(range.end).toBe(6);
    expect(range.total).toBe(6 * ROW);
  });

  it("renders every row when they all fit", () => {
    const range = windowRange(6, 0, 800, ROW);
    expect(range.start).toBe(0);
    expect(range.end).toBe(6);
  });

  it("windows a large list", () => {
    const range = windowRange(23000, 0, 800, ROW);
    expect(range.start).toBe(0);
    expect(range.end).toBeLessThan(50);
    expect(range.total).toBe(23000 * ROW);
  });

  it("moves the window as the list scrolls", () => {
    const range = windowRange(23000, 100 * ROW, 800, ROW);
    expect(range.start).toBe(92);
    expect(range.offset).toBe(92 * ROW);
    expect(range.end).toBeGreaterThan(100);
  });

  it("never starts before the first row", () => {
    expect(windowRange(100, 0, 800, ROW).start).toBe(0);
    expect(windowRange(100, -500, 800, ROW).start).toBe(0);
  });

  it("never ends past the last row", () => {
    const range = windowRange(10, 10_000, 800, ROW);
    expect(range.end).toBe(10);
    expect(range.start).toBeLessThanOrEqual(10);
  });

  it("still renders rows when the list shrinks under a scrolled viewport", () => {
    // A search narrowing 23000 results down to 4 while scrolled far down must
    // not leave the window starting past the end, which would render nothing.
    const range = windowRange(4, 22000 * ROW, 800, ROW);
    expect(range.start).toBe(0);
    expect(range.end).toBe(4);
    expect(range.end).toBeGreaterThan(range.start);
  });

  it("start is never greater than end", () => {
    for (const count of [0, 1, 5, 100, 23000]) {
      for (const scrollTop of [0, 1000, 100_000]) {
        const range = windowRange(count, scrollTop, 800, ROW);
        expect(range.start, `count=${count} scrollTop=${scrollTop}`).toBeLessThanOrEqual(
          range.end,
        );
      }
    }
  });

  it("handles an empty list", () => {
    expect(windowRange(0, 0, 800, ROW)).toEqual({ start: 0, end: 0, offset: 0, total: 0 });
  });

  it("refuses to divide by a zero row height", () => {
    expect(windowRange(10, 0, 800, 0).end).toBe(0);
  });

  it("keeps the rendered slice bounded no matter how far down we are", () => {
    const range = windowRange(23000, 22000 * ROW, 800, ROW);
    expect(range.end - range.start).toBeLessThan(50);
    expect(range.end).toBeLessThanOrEqual(23000);
  });

  it("offset always matches the first rendered row", () => {
    for (const scrollTop of [0, 500, 5000, 50_000]) {
      const range = windowRange(23000, scrollTop, 800, ROW);
      expect(range.offset).toBe(range.start * ROW);
    }
  });
});

/** A separator, then two rows, then a separator, then two rows. */
const MIXED = [24, ROW, ROW, 24, ROW, ROW];

describe("offsetsOf", () => {
  it("is a prefix sum with the total on the end", () => {
    expect(offsetsOf([10, 20, 30])).toEqual([0, 10, 30, 60]);
  });

  it("answers a single zero for an empty list", () => {
    expect(offsetsOf([])).toEqual([0]);
  });
});

describe("entryAt", () => {
  const offsets = offsetsOf(MIXED);

  it("finds the entry a position falls inside", () => {
    expect(entryAt(offsets, 0)).toBe(0);
    expect(entryAt(offsets, 23)).toBe(0);
    expect(entryAt(offsets, 24)).toBe(1);
    expect(entryAt(offsets, 24 + ROW)).toBe(2);
  });

  /** A scroll position past the end is a list that shrank under the viewport. */
  it("clamps to the last entry rather than running off the end", () => {
    expect(entryAt(offsets, 10_000)).toBe(MIXED.length - 1);
    expect(entryAt(offsets, -50)).toBe(0);
  });
});

describe("windowSlice", () => {
  it("renders everything when it all fits", () => {
    const slice = windowSlice(offsetsOf(MIXED), 0, 800);
    expect(slice.start).toBe(0);
    expect(slice.end).toBe(MIXED.length);
    expect(slice.total).toBe(24 * 2 + ROW * 4);
  });

  /**
   * The whole reason this exists. With a uniform pitch every offset below a
   * heading is wrong by the height of every heading above it, and the error
   * compounds — a thousand rows in, the list scrolls to the wrong thread.
   */
  it("puts the slab where the first rendered entry actually starts", () => {
    const heights = Array.from({ length: 400 }, (_, i) => (i % 21 === 0 ? 24 : ROW));
    const offsets = offsetsOf(heights);

    for (const scrollTop of [0, 500, 5000, 15_000]) {
      const slice = windowSlice(offsets, scrollTop, 800);
      expect(slice.offset).toBe(offsets[slice.start]);
    }
  });

  it("keeps the rendered slice bounded however far down it is", () => {
    const heights = Array.from({ length: 23_000 }, () => ROW);
    const offsets = offsetsOf(heights);
    const slice = windowSlice(offsets, 22_000 * ROW, 800);

    expect(slice.end - slice.start).toBeLessThan(50);
    expect(slice.end).toBeLessThanOrEqual(23_000);
  });

  it("covers the bottom edge of the viewport, not just the top", () => {
    const heights = Array.from({ length: 200 }, () => ROW);
    const slice = windowSlice(offsetsOf(heights), 0, 800, 0);

    // Everything the viewport touches is rendered: the last entry that starts
    // before 800px is index 13, so the slice has to reach past it.
    expect(slice.end).toBeGreaterThan(Math.floor(800 / ROW));
  });

  it("answers nothing for an empty list", () => {
    expect(windowSlice(offsetsOf([]), 0, 800)).toEqual({
      start: 0,
      end: 0,
      offset: 0,
      total: 0,
    });
  });
});
