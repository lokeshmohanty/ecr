import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "../api/types";
import { entriesOf, listGroups } from "./list-groups";

const NOW = new Date("2026-08-19T12:00:00Z");

const at = (iso: string, id = iso): ThreadSummary => ({
	id,
	subject: id,
	authors: [],
	timestamp: Math.floor(new Date(iso).getTime() / 1000),
	date_relative: "",
	matched: 1,
	total: 1,
	tags: [],
	newest_message: null,
});

const labels = (threads: ThreadSummary[], zone = "UTC") =>
	listGroups(threads, zone, NOW).map((g) => g.label);

describe("listGroups", () => {
	/**
	 * The granularity is the whole design: a heading per day is a rule every
	 * third row on a quiet mailbox, so only the two days a reader thinks in get
	 * one.
	 */
	it("names today and yesterday, then months, then years", () => {
		expect(
			labels([
				at("2026-08-19T09:00:00Z"),
				at("2026-08-18T09:00:00Z"),
				at("2026-08-15T09:00:00Z"),
				at("2026-03-02T09:00:00Z"),
				at("2025-11-30T09:00:00Z"),
				at("2024-01-04T09:00:00Z"),
			]),
		).toEqual(["Today", "Yesterday", "August", "March", "2025", "2024"]);
	});

	it("carries the span each heading was built at", () => {
		expect(
			listGroups(
				[
					at("2026-08-19T09:00:00Z"),
					at("2026-08-15T09:00:00Z"),
					at("2025-11-30T09:00:00Z"),
				],
				"UTC",
				NOW,
			).map((g) => g.span),
		).toEqual(["day", "month", "year"]);
	});

	it("gathers a run into a single heading", () => {
		const groups = listGroups(
			[
				at("2026-08-15T09:00:00Z", "a"),
				at("2026-08-14T08:00:00Z", "b"),
				at("2026-08-02T23:00:00Z", "c"),
				at("2026-07-30T23:00:00Z", "d"),
			],
			"UTC",
			NOW,
		);

		expect(groups).toEqual([
			{ key: "month:2026-08", label: "August", span: "month", start: 0, count: 3 },
			{ key: "month:2026-07", label: "July", span: "month", start: 3, count: 1 },
		]);
	});

	/**
	 * The list is drawn in the order the query answered. Collecting every row of
	 * a month under one heading would reorder it to suit the headings.
	 */
	it("gives a period that appears twice two headings", () => {
		expect(
			labels([
				at("2026-08-15T09:00:00Z", "a"),
				at("2026-07-18T09:00:00Z", "b"),
				at("2026-08-07T07:00:00Z", "c"),
			]),
		).toEqual(["August", "July", "August"]);
	});

	/**
	 * The boundary is the reader's, not the machine's — 20:00 UTC is already
	 * tomorrow in Kolkata, so the same message is yesterday's in one zone and
	 * today's in the other.
	 */
	it("computes every boundary in the display zone", () => {
		const late = [at("2026-08-18T20:00:00Z")];
		expect(labels(late, "UTC")).toEqual(["Yesterday"]);
		expect(labels(late, "Asia/Kolkata")).toEqual(["Today"]);

		// And the same at the year's edge: 31 December here is 1 January there.
		const newYear = [at("2025-12-31T20:00:00Z")];
		expect(labels(newYear, "UTC")).toEqual(["2025"]);
		expect(labels(newYear, "Asia/Kolkata")).toEqual(["January"]);
	});

	it("leaves an undated thread under the heading it arrived beneath", () => {
		const undated = { ...at("2026-08-19T09:00:00Z", "x"), timestamp: 0 };
		const groups = listGroups([at("2026-08-19T09:00:00Z"), undated], "UTC", NOW);

		expect(groups).toHaveLength(1);
		expect(groups[0]!.count).toBe(2);
	});

	it("answers nothing for an empty page", () => {
		expect(listGroups([], "UTC", NOW)).toEqual([]);
	});
});

describe("entriesOf", () => {
	const threads = [
		at("2026-08-19T09:00:00Z", "a"),
		at("2026-08-15T09:00:00Z", "b"),
	];
	const entries = () => entriesOf(threads, listGroups(threads, "UTC", NOW));

	it("puts a heading in front of each run", () => {
		expect(entries().map((e) => e.kind)).toEqual([
			"heading",
			"thread",
			"heading",
			"thread",
		]);
	});

	/**
	 * The cursor, the selection and every tag operation are indices into the
	 * *thread* list. A heading that shifted them by one would stage a delete on
	 * the row below the one under the cursor.
	 */
	it("leaves every thread carrying its own index", () => {
		const rows = entries().filter((e) => e.kind === "thread");
		expect(rows.map((e) => e.index)).toEqual([0, 1]);
	});

	/** What a row prints is decided by the heading it is under, not by itself. */
	it("hands each thread the span of the heading above it", () => {
		const rows = entries().filter((e) => e.kind === "thread");
		expect(rows.map((e) => e.span)).toEqual(["day", "month"]);
	});

	it("leaves a thread with no heading above it without a span", () => {
		const rows = entriesOf(threads, []).filter((e) => e.kind === "thread");
		expect(rows.every((e) => e.span === undefined)).toBe(true);
	});
});
