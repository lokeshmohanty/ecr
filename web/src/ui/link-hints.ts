/**
 * Opening a link without a pointer.
 *
 * `u` labels every link on screen and the label opens it. That is the same
 * trick vimium and qutebrowser use, and it exists here for the same reason:
 * view mode can already reach a link, but only by walking the document to it,
 * which is a lot of keys to press to open the one URL in a message.
 *
 * The labels have to be reachable without moving off the home row, so the
 * alphabet is the home row — the keys a touch typist's fingers are already on.
 */

/**
 * The label alphabet, strongest keys first.
 *
 * `g` is missing on purpose: it is the prefix of `gg` and friends elsewhere in
 * the client, and a label that shadows a motion is a label that teaches the
 * reader not to trust the hint. The rest of the keyboard follows the home row
 * so that a message with more links than fingers still gets labels.
 */
export const HINT_KEYS = "asdfhjkl" + "qwertyuiopzxcvbnm";

export interface LinkTarget {
	href: string;
	/** Page coordinates, so a hint over an iframe lands in the right place. */
	x: number;
	y: number;
}

export interface Hint extends LinkTarget {
	label: string;
}

/**
 * Anything that can say where it sits — the message frame, in practice.
 *
 * Structural rather than `HTMLIFrameElement` because the plain-text pane hands
 * over a plain element and the frame hands over an iframe, and all this needs
 * from either is the one rectangle.
 */
export interface Positioned {
	getBoundingClientRect(): { left: number; top: number };
}

/**
 * One label per link, all the same length.
 *
 * Uniform length is the whole correctness argument: with mixed lengths `a`
 * would be a prefix of `ab`, so typing `a` could either open a link or be
 * halfway to another, and the only ways out are a timeout or a commit key.
 * Same-length labels make every keystroke unambiguous — the buffer either is a
 * label or is not yet one.
 */
export function labelsFor(count: number, alphabet: string = HINT_KEYS): string[] {
	if (count <= 0 || alphabet.length === 0) return [];

	const keys = [...alphabet];
	let width = 1;
	let capacity = keys.length;
	while (capacity < count) {
		width += 1;
		capacity *= keys.length;
	}

	const labels: string[] = [];
	const build = (prefix: string) => {
		if (labels.length >= count) return;
		if (prefix.length === width) {
			labels.push(prefix);
			return;
		}
		for (const key of keys) build(prefix + key);
	};
	build("");

	return labels;
}

/**
 * Every link a reader can see, in reading order, with a label each.
 *
 * `root` is whichever document is on screen — the plain-text pane lives in the
 * app's own DOM, and an HTML message lives inside the sandboxed frame. When it
 * is the frame, its rectangles are relative to *its* viewport, so the frame's
 * own position is added: without that every hint stacks up at the top of the
 * pane, pointing at nothing.
 *
 * Links with no box are skipped. A `display:none` anchor, or one inside a
 * collapsed quote, has a zero-sized rectangle and labelling it would spend a
 * key on something the reader cannot see.
 */
export function hintsFor(
	root: ParentNode | null | undefined,
	frame?: Positioned | null,
	alphabet: string = HINT_KEYS,
): Hint[] {
	if (!root) return [];

	const offset = frame?.getBoundingClientRect();
	const left = offset?.left ?? 0;
	const top = offset?.top ?? 0;

	const targets: LinkTarget[] = [];
	for (const node of Array.from(root.querySelectorAll("a[href]"))) {
		const href = node.getAttribute("href");
		if (!href) continue;

		const box = node.getBoundingClientRect?.();
		if (!box || (box.width === 0 && box.height === 0)) continue;

		targets.push({ href, x: box.left + left, y: box.top + top });
	}

	const labels = labelsFor(targets.length, alphabet);
	const hints: Hint[] = [];
	targets.forEach((target, index) => {
		const label = labels[index];
		if (label) hints.push({ ...target, label });
	});
	return hints;
}

export type HintMatch =
	| { kind: "open"; href: string }
	| { kind: "pending" }
	| { kind: "none" };

/**
 * What a typed buffer means against a set of hints.
 *
 * `none` is a keystroke that cannot become any label, which cancels rather than
 * being swallowed — a reader who typed the wrong key wants the hints gone, not
 * a buffer quietly accumulating rubbish.
 */
export function matchHint(hints: Hint[], typed: string): HintMatch {
	if (!typed) return { kind: "pending" };

	const exact = hints.find((hint) => hint.label === typed);
	if (exact) return { kind: "open", href: exact.href };

	const partial = hints.some((hint) => hint.label.startsWith(typed));
	return partial ? { kind: "pending" } : { kind: "none" };
}
