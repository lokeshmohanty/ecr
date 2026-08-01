import { describe, expect, it } from "vitest";

import { formatListDate, isDateFormat, isTimezone } from "./datetime";

const KOLKATA = "Asia/Kolkata";

/** 2026-08-01 18:00 IST — the "now" every case below is measured against. */
const NOW = new Date("2026-08-01T12:30:00Z");

const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

describe("formatListDate, adaptive", () => {
  it("shows only the clock for a message from today", () => {
    expect(formatListDate(at("2026-08-01T09:02:00Z"), "adaptive", KOLKATA, NOW)).toBe("14:32");
  });

  it("shows day, month and clock for an earlier day this year", () => {
    expect(formatListDate(at("2026-04-04T03:45:00Z"), "adaptive", KOLKATA, NOW)).toBe(
      "04 Apr 09:15",
    );
  });

  it("shows the ISO date for a message from another year", () => {
    expect(formatListDate(at("2024-11-02T08:00:00Z"), "adaptive", KOLKATA, NOW)).toBe("2024-11-02");
  });

  it("uses the display zone for the day boundary, not the machine's", () => {
    // 19:00 UTC on the 1st is 00:30 IST on the 2nd — tomorrow in Kolkata.
    const late = at("2026-08-01T19:00:00Z");

    expect(formatListDate(late, "adaptive", KOLKATA, NOW)).toBe("02 Aug 00:30");
    expect(formatListDate(late, "adaptive", "UTC", NOW)).toBe("19:00");
  });

  it("puts the year boundary in the display zone too", () => {
    // 18:35Z on new year's eve is already 00:05 on the 1st in Kolkata, so it is
    // this year and keeps its clock; half an hour earlier is still last year.
    expect(formatListDate(at("2025-12-31T18:35:00Z"), "adaptive", KOLKATA, NOW)).toBe(
      "01 Jan 00:05",
    );
    expect(formatListDate(at("2025-12-31T18:00:00Z"), "adaptive", KOLKATA, NOW)).toBe("2025-12-31");
  });
});

describe("formatListDate, the other formats", () => {
  const noon = at("2026-04-04T03:45:00Z");

  it("time is always the clock", () => {
    expect(formatListDate(noon, "time", KOLKATA, NOW)).toBe("09:15");
  });

  it("datetime is always day, month and clock", () => {
    expect(formatListDate(noon, "datetime", KOLKATA, NOW)).toBe("04 Apr 09:15");
  });

  it("iso is always the date, and sorts as a string", () => {
    expect(formatListDate(noon, "iso", KOLKATA, NOW)).toBe("2026-04-04");
    expect(formatListDate(at("2024-01-09T00:00:00Z"), "iso", KOLKATA, NOW)).toBe("2024-01-09");
  });

  it("relative counts down through the units", () => {
    expect(formatListDate(at("2026-08-01T12:29:30Z"), "relative", KOLKATA, NOW)).toBe("now");
    expect(formatListDate(at("2026-08-01T12:00:00Z"), "relative", KOLKATA, NOW)).toBe("30m");
    expect(formatListDate(at("2026-08-01T06:30:00Z"), "relative", KOLKATA, NOW)).toBe("6h");
    expect(formatListDate(at("2026-07-29T12:30:00Z"), "relative", KOLKATA, NOW)).toBe("3d");
    expect(formatListDate(at("2026-04-04T03:45:00Z"), "relative", KOLKATA, NOW)).toBe("04 Apr");
    expect(formatListDate(at("2024-11-02T08:00:00Z"), "relative", KOLKATA, NOW)).toBe("Nov 2024");
  });
});

describe("formatListDate, bad input", () => {
  it("renders nothing rather than 1970 for a missing timestamp", () => {
    expect(formatListDate(0, "adaptive", KOLKATA, NOW)).toBe("");
    expect(formatListDate(-1, "adaptive", KOLKATA, NOW)).toBe("");
    expect(formatListDate(Number.NaN, "adaptive", KOLKATA, NOW)).toBe("");
  });

  it("an empty zone falls back to the machine's own", () => {
    expect(formatListDate(at("2026-04-04T03:45:00Z"), "iso", "", NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("validation", () => {
  it("knows the formats it supports", () => {
    expect(isDateFormat("adaptive")).toBe(true);
    expect(isDateFormat("relative")).toBe(true);
    expect(isDateFormat("fuzzy")).toBe(false);
  });

  it("knows a real timezone from a typo", () => {
    expect(isTimezone("Asia/Kolkata")).toBe(true);
    expect(isTimezone("UTC")).toBe(true);
    expect(isTimezone("")).toBe(true);
    expect(isTimezone("Asia/Kolkatta")).toBe(false);
    expect(isTimezone("Mars/Olympus")).toBe(false);
  });
});
