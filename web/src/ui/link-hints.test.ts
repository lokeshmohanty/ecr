import { describe, expect, it } from "vitest";
import { HINT_KEYS, hintsFor, labelsFor, matchHint } from "./link-hints";

describe("hint labels", () => {
	it("uses one key per link while there are keys to spare", () => {
		expect(labelsFor(3, "asdf")).toEqual(["a", "s", "d"]);
	});

	/**
	 * Uniform length is what makes every keystroke unambiguous. Were `a` and
	 * `ab` both labels, typing `a` would be either an open or half of one, and
	 * the only ways to tell are a timeout or a commit key — both of which make
	 * the fast path slower than the pointer it replaces.
	 */
	it("grows every label together rather than mixing lengths", () => {
		const labels = labelsFor(6, "asd");
		expect(labels).toEqual(["aa", "as", "ad", "sa", "ss", "sd"]);
		expect(new Set(labels.map((l) => l.length))).toEqual(new Set([2]));
	});

	it("keeps going past a single doubling", () => {
		expect(labelsFor(10, "as")).toHaveLength(10);
		expect(new Set(labelsFor(10, "as").map((l) => l.length))).toEqual(
			new Set([4]),
		);
	});

	it("has nothing to label when there are no links", () => {
		expect(labelsFor(0)).toEqual([]);
	});

	/** `g` prefixes motions elsewhere; a label that shadows one is a trap. */
	it("leaves g out of the alphabet", () => {
		expect(HINT_KEYS).not.toContain("g");
		expect(HINT_KEYS.startsWith("asdfhjkl")).toBe(true);
	});
});

describe("matching what was typed", () => {
	const hints = [
		{ href: "https://one", x: 0, y: 0, label: "aa" },
		{ href: "https://two", x: 0, y: 0, label: "as" },
	];

	it("waits while the buffer is still a prefix", () => {
		expect(matchHint(hints, "a")).toEqual({ kind: "pending" });
	});

	it("opens on a complete label", () => {
		expect(matchHint(hints, "as")).toEqual({
			kind: "open",
			href: "https://two",
		});
	});

	/** A wrong key cancels; a buffer quietly collecting rubbish does not. */
	it("gives up on a key that cannot become a label", () => {
		expect(matchHint(hints, "z")).toEqual({ kind: "none" });
	});
});

describe("collecting the links on screen", () => {
	function root(html: string): HTMLElement {
		const host = document.createElement("div");
		host.innerHTML = html;
		// jsdom gives every element a zero box, so the sizes are stubbed to
		// stand for "this one is visible".
		for (const node of Array.from(host.querySelectorAll("a"))) {
			const visible = !node.hasAttribute("data-hidden");
			node.getBoundingClientRect = () =>
				({
					left: 10,
					top: 20,
					width: visible ? 50 : 0,
					height: visible ? 10 : 0,
				}) as DOMRect;
		}
		return host;
	}

	it("labels each link in reading order", () => {
		const hints = hintsFor(
			root('<a href="https://one">1</a><a href="https://two">2</a>'),
		);
		expect(hints.map((h) => [h.label, h.href])).toEqual([
			["a", "https://one"],
			["s", "https://two"],
		]);
	});

	/** A key spent on something the reader cannot see is a key wasted. */
	it("skips a link with no box", () => {
		const hints = hintsFor(
			root('<a href="https://gone" data-hidden>x</a><a href="https://here">y</a>'),
		);
		expect(hints.map((h) => h.href)).toEqual(["https://here"]);
	});

	it("ignores an anchor with no href", () => {
		expect(hintsFor(root("<a>no href</a>"))).toEqual([]);
	});

	/**
	 * An HTML message is inside the sandboxed frame, so its rectangles are
	 * relative to that frame's viewport. Without adding the frame's own
	 * position every hint stacks at the top of the pane, pointing at nothing.
	 */
	it("offsets hints inside the message frame by the frame's position", () => {
		const frame = { getBoundingClientRect: () => ({ left: 100, top: 200 }) };

		const hints = hintsFor(root('<a href="https://one">1</a>'), frame);
		expect(hints).toHaveLength(1);
		expect([hints[0]?.x, hints[0]?.y]).toEqual([110, 220]);
	});

	it("has nothing to show for a pane that is not there", () => {
		expect(hintsFor(null)).toEqual([]);
	});
});
