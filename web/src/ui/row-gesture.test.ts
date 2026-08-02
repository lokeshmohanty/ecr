import { describe, expect, it } from "vitest";
import { SWIPE_COMMIT, drag, stillPressing } from "./row-gesture";

describe("swiping a row", () => {
  it("does nothing until the finger has clearly gone sideways", () => {
    expect(drag(4, 0)).toEqual({ offset: 0, commit: null, horizontal: false });
    expect(drag(11, 2)).toEqual({ offset: 0, commit: null, horizontal: false });
  });

  it("keeps scrolling when the finger is mostly going down", () => {
    // The common case by far: a thumb dragging the list never slides a row.
    expect(drag(20, 40).horizontal).toBe(false);
    expect(drag(-30, 31).horizontal).toBe(false);
  });

  it("follows the finger once sideways wins", () => {
    const d = drag(40, 5);
    expect(d.horizontal).toBe(true);
    expect(d.offset).toBe(40);
    expect(d.commit).toBe(null);
  });

  it("archives to the left and flags to the right", () => {
    expect(drag(-SWIPE_COMMIT, 0).commit).toBe("archive");
    expect(drag(SWIPE_COMMIT, 0).commit).toBe("flag");
  });

  it("resists past the commit point rather than running off the screen", () => {
    const far = drag(-400, 0);
    expect(far.commit).toBe("archive");
    expect(Math.abs(far.offset)).toBeLessThan(200);
    expect(Math.abs(far.offset)).toBeGreaterThan(SWIPE_COMMIT);
  });

  it("is symmetric, so neither direction is easier to trigger", () => {
    expect(drag(70, 3).offset).toBe(-drag(-70, 3).offset);
  });
});

describe("holding a row", () => {
  it("survives the wobble of a finger holding still", () => {
    expect(stillPressing(0, 0)).toBe(true);
    expect(stillPressing(6, 6)).toBe(true);
  });

  it("gives up once the finger is plainly moving", () => {
    expect(stillPressing(0, 24)).toBe(false);
    expect(stillPressing(30, 0)).toBe(false);
  });
});
