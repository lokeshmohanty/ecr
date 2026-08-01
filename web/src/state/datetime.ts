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

const cache = new Map<string, Intl.DateTimeFormat>();

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
function dayKey(date: Date, zone: string): string {
  return formatter(zone, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function yearOf(date: Date, zone: string): string {
  return formatter(zone, { year: "numeric" }).format(date);
}

/**
 * `now` is a parameter rather than `Date.now()` so the boundaries are testable
 * and so a list rendered in one pass cannot straddle midnight.
 */
export function formatListDate(
  timestamp: number,
  format: DateFormat,
  zone: string,
  now: Date = new Date(),
): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";

  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return "";

  const time = () => formatter(zone, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const dayMonth = () => formatter(zone, { day: "2-digit", month: "short" }).format(date);
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
