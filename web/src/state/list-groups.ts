import type { ThreadSummary } from "../api/types";
import { dayKey, yearOf, zoneFormatter, type Span } from "./datetime";

/**
 * A heading over a run of rows, and how much of the date it says.
 *
 * The granularity is not uniform, and that is the point: *Today* and
 * *Yesterday* are how a reader thinks about the top of their list, and a
 * heading per day below that is a rule every third row on a quiet mailbox —
 * headings the eye has to step over to find mail. So the rest of this year is
 * grouped by month and everything before it by year, which keeps a heading
 * meaning "here is where the mail changes era" rather than "here is another
 * Tuesday".
 *
 * `span` is carried through to the rows: a row prints what its heading does
 * not, so the same value decides both, and they cannot drift into saying the
 * month twice.
 */
export interface ListGroup {
	/** Stable across renders: `day:2026-08-19`, `month:2026-08`, `year:2025`. */
	key: string;
	/** What the heading says: `Today`, `Yesterday`, `August`, `2025`. */
	label: string;
	span: Span;
	/** Index into the thread list of the first row under this heading. */
	start: number;
	/** How many rows are under it. */
	count: number;
}

/** A heading or a thread, in the order they are drawn. */
export type Entry =
	| { kind: "heading"; key: string; label: string; index: number }
	| {
			kind: "thread";
			thread: ThreadSummary;
			index: number;
			/**
			 * The granularity of the heading above, so the row can say the rest.
			 * Absent when there is no heading above it — an undated thread at the
			 * very top of a page — and then the row prints the full adaptive date,
			 * because nothing above it has said any of it.
			 */
			span?: Span;
	  };

/** The parts of a date, in the display zone rather than the machine's. */
function partsOf(date: Date, zone: string): { year: string; month: string } {
	const parts = zoneFormatter(zone, {
		year: "numeric",
		month: "2-digit",
	}).formatToParts(date);

	const at = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return { year: at("year"), month: at("month") };
}

/**
 * Which heading a date belongs under.
 *
 * Every boundary is computed in the display zone, the same rule the rest of
 * `datetime.ts` keeps: a heading that disagrees with the clock printed beside
 * it on its own rows is worse than no heading.
 */
function headingFor(
	date: Date,
	now: Date,
	zone: string,
): { key: string; label: string; span: Span } {
	const day = dayKey(date, zone);

	if (day === dayKey(now, zone))
		return { key: `day:${day}`, label: "Today", span: "day" };

	const yesterday = new Date(now.getTime() - 86_400_000);
	if (day === dayKey(yesterday, zone))
		return { key: `day:${day}`, label: "Yesterday", span: "day" };

	const { year, month } = partsOf(date, zone);

	if (year === yearOf(now, zone))
		return {
			key: `month:${year}-${month}`,
			label: zoneFormatter(zone, { month: "long" }).format(date),
			span: "month",
		};

	return { key: `year:${year}`, label: year, span: "year" };
}

/**
 * The headings for a page of threads.
 *
 * Grouping is over *contiguous* runs rather than by unique period, and that is
 * deliberate: the list is in whatever order the query answered it in, and
 * gathering every row of a month into one group would reorder the mail to suit
 * the headings — the one thing a heading must never do. So a period that
 * appears twice gets two headings, and the list stays exactly as it came.
 *
 * `now` is a parameter rather than `Date.now()` so *Today* is testable and so
 * one render cannot straddle midnight — the contract `formatListDate` keeps.
 */
export function listGroups(
	threads: ThreadSummary[],
	zone: string,
	now: Date = new Date(),
): ListGroup[] {
	const groups: ListGroup[] = [];

	threads.forEach((thread, index) => {
		// A thread the server could not date belongs under whatever heading it
		// arrived beneath: inventing one for it would put a heading in the middle
		// of a month, and starting a group for it would put an empty date on
		// screen.
		if (!Number.isFinite(thread.timestamp) || thread.timestamp <= 0) {
			const open = groups[groups.length - 1];
			if (open) open.count += 1;
			return;
		}

		const heading = headingFor(new Date(thread.timestamp * 1000), now, zone);
		const open = groups[groups.length - 1];

		if (open && open.key === heading.key) {
			open.count += 1;
			return;
		}

		groups.push({ ...heading, start: index, count: 1 });
	});

	return groups;
}

/**
 * The rows and the headings, in one list, in the order they are drawn.
 *
 * A thread keeps its *thread* index — the cursor, the selection and every tag
 * operation are indices into the thread list, and a heading must not shift any
 * of them by one.
 */
export function entriesOf(
	threads: ThreadSummary[],
	groups: ListGroup[],
): Entry[] {
	const entries: Entry[] = [];
	let group = 0;
	// Threads before the first heading, and threads the server could not date,
	// take the span of whatever they are under. Before any heading exists there
	// is nothing above them, so the full adaptive date is the honest answer.
	let span: Span | undefined;

	threads.forEach((thread, index) => {
		const next = groups[group];
		if (next && next.start === index) {
			entries.push({
				kind: "heading",
				key: next.key,
				label: next.label,
				index,
			});
			span = next.span;
			group += 1;
		}
		entries.push({ kind: "thread", thread, index, span });
	});

	return entries;
}
