/**
 * notmuch's own `date_relative` is a sentence ("now", "April 01"), which reads
 * well in isolation and badly in a column: it is never the same width, and it
 * never says what time a message arrived. The list formats the timestamp
 * instead, which is on the wire already.
 */
export type DateFormat = "adaptive" | "time" | "datetime" | "iso" | "relative";

export const DATE_FORMATS: DateFormat[] = [
  "adaptive",
  "time",
  "datetime",
  "iso",
  "relative",
];

export function isDateFormat(value: string): value is DateFormat {
  return (DATE_FORMATS as string[]).includes(value);
}

/** An empty zone means the machine's own, which is what a bare formatter uses. */
export function isTimezone(zone: string): boolean {
  if (zone.trim() === "") return true;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * How much of a date a list heading has already said.
 *
 * The list groups its rows under headings, and a row's date is what the
 * heading above it does not carry: under *Today* the clock is all that is
 * left to say, under *August* the day, under *2025* the day and the month.
 * Printing `18 Aug 23:15` under a heading that reads AUGUST says the month
 * twice and spends seven characters of a column the subject wants.
 */
export type Span = "day" | "month" | "year";

const cache = new Map<string, Intl.DateTimeFormat>();

export function zoneFormatter(
  zone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  return formatter(zone, options);
}

function formatter(zone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${zone}|${JSON.stringify(options)}`;
  const found = cache.get(key);
  if (found) return found;

  const made = new Intl.DateTimeFormat("en-GB", {
    ...options,
    ...(zone.trim() === "" ? {} : { timeZone: zone }),
  });
  cache.set(key, made);
  return made;
}

/**
 * The day boundaries have to be computed in the display zone, not the machine's,
 * or a message is "today" in one pane and yesterday in another. Formatting the
 * date parts and comparing the strings is what makes that zone-correct without
 * pulling in a date library.
 */
export function dayKey(date: Date, zone: string): string {
  return formatter(zone, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function yearOf(date: Date, zone: string): string {
  return formatter(zone, { year: "numeric" }).format(date);
}

/**
 * `now` is a parameter rather than `Date.now()` so the boundaries are testable
 * and so a list rendered in one pass cannot straddle midnight.
 *
 * `under` is the heading this row is sitting beneath, and it narrows the
 * *adaptive* format only. The other four are explicit choices — somebody who
 * asked for ISO wants ISO on every row, and quietly dropping half of it because
 * a heading mentioned the month would be answering a question they did not ask.
 */
export function formatListDate(
  timestamp: number,
  format: DateFormat,
  zone: string,
  now: Date = new Date(),
  under?: Span,
): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";

  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return "";

  const time = () => formatter(zone, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const dayMonth = () => formatter(zone, { day: "2-digit", month: "short" }).format(date);
  const weekdayDay = () =>
    formatter(zone, { weekday: "short", day: "2-digit" }).format(date);
  const iso = () =>
    formatter(zone, { year: "numeric", month: "2-digit", day: "2-digit" })
      .format(date)
      .split("/")
      .reverse()
      .join("-");

  switch (format) {
    case "time":
      return time();
    case "iso":
      return iso();
    case "datetime":
      return `${dayMonth()} ${time()}`;
    case "relative":
      return relative(date, now, zone);
    case "adaptive":
    default:
      // What the heading above has not already said. The weekday comes in at
      // month granularity because within a month the day number alone reads as
      // an index — and which day of the week a message arrived is most of what
      // anyone remembers about when it did.
      if (under === "day") return time();
      if (under === "month") return weekdayDay();
      if (under === "year") return dayMonth();

      if (dayKey(date, zone) === dayKey(now, zone)) return time();
      if (yearOf(date, zone) === yearOf(now, zone)) return `${dayMonth()} ${time()}`;
      return iso();
  }
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function relative(date: Date, now: Date, zone: string): string {
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < 0) return "later";
  if (seconds < MINUTE) return "now";
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h`;
  if (seconds < 7 * DAY) return `${Math.floor(seconds / DAY)}d`;

  return yearOf(date, zone) === yearOf(now, zone)
    ? formatter(zone, { day: "2-digit", month: "short" }).format(date)
    : formatter(zone, { year: "numeric", month: "short" }).format(date);
}
