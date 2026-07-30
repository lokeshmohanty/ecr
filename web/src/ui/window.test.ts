import { describe, expect, it } from "vitest";
import { windowRange } from "./window";

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
