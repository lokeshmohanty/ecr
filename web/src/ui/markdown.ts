/**
 * The reading text, rendered.
 *
 * `BodyFormat::Text` is the message's markup read as Markdown — see
 * `ecr_store::markdown` — and it used to be shown exactly as it arrived, on the
 * grounds that Markdown is legible without anything rendering it. It is, up to
 * a point, and the point is emphasis: `Rich **HTML** body` is not a sentence
 * anyone wants to read, and `[the notes](https://…/a/very/long/path)` is a URL
 * wedged into the middle of one. The punctuation stands in for something rather
 * than decorating it, which is the same reason images had to be rendered.
 *
 * So this renders the marks and keeps everything else. The pane stays a
 * monospaced `<pre>` with the source's own newlines: nothing here emits a block
 * element, so a line is still a line, `j`/`k` in view mode still move by one,
 * and the flat text view is still recognisably the flat text view rather than a
 * second copy of the HTML one.
 *
 * What the converter actually emits is the whole of what is handled, and it is
 * a short list: `**strong**`, `*em*`, `` `code` ``, `#` headings, `>` quotes,
 * `- `/`1. ` list markers, `* * *` rules and ``` fences. There is no
 * strikethrough because htmd drops `<s>` entirely, and no tables because it
 * writes each cell as its own paragraph.
 *
 * Only two things here reach the DOM as anything but text — an image's `src`
 * and a link's `href` — and both are checked against what they are allowed to
 * be. Everything else is escaped.
 */
import { escapeHtml, linkify } from "./linkify";

/**
 * What an image is allowed to point at.
 *
 * The server has already resolved `cid:` to a part of this message and dropped,
 * or kept, whatever was remote according to the reader's setting — so a target
 * arriving here was meant to be fetched. This is the second layer.
 *
 * `data:image/svg+xml` is refused with the rest. An `<img>` does not run script
 * in an SVG it loads, so that is safe by specification rather than by
 * construction, and nothing in mail needs it.
 */
const FETCHABLE = /^(?:https?:\/\/|\/(?!\/)|data:image\/(?!svg))/i;

/**
 * What a link is allowed to point at.
 *
 * Wider than `FETCHABLE`, because `mailto:` is a thing a message legitimately
 * says and `ui/follow-link.ts` turns one into a composer. Narrower than
 * everything, because `javascript:` is a scheme.
 */
const FOLLOWABLE = /^(?:https?:\/\/|mailto:|\/(?!\/))/i;

/** htmd writes a `<pre><code>` block between these. */
const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
/** And an `<hr>` as this. Tested before the bullet, which it would also match. */
const RULE = /^\s*(?:\*\s?){3,}\s*$/;
const QUOTE = /^((?:>\s?)+)(.*)$/;
/**
 * A list marker.
 *
 * The space after it is what keeps `*emphasis*` out: a marker is followed by
 * the item, an opening delimiter is followed by the word it opens.
 */
const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/**
 * Everything inline, in one ordered alternation.
 *
 * One pass rather than one per construct, because scanning separately means
 * whichever ran second sees the other's output — `![alt](url)` found again as a
 * bare `!` beside a link, `**bold**` found again as two empty emphases. The
 * order is the precedence: a backtick span is literal, so it wins over
 * everything inside it, and `**` is tried before `*` at the same position.
 *
 * `(?=\S)` on both emphases is what keeps arithmetic and prose out of it: an
 * opening delimiter is followed by the word it opens, never by a space, so
 * `2 * 3 * 4` is multiplication and stays that way.
 */
const INLINE = new RegExp(
	[
		"`([^`\\n]+)`", // 1 code
		"(!?)\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)", // 2 bang, 3 label, 4 target
		"\\*\\*(?=\\S)([^\\n]*?\\S)\\*\\*", // 5 strong
		"\\*(?=\\S)([^*\\n]*?\\S|\\S)\\*", // 6 em
	].join("|"),
	"g",
);

/**
 * How far emphasis may nest before it is read as text.
 *
 * Message bodies are untrusted, and the inner content of a match is rendered by
 * the same function that found it. Real mail nests two deep at the most; a run
 * of asterisks contrived to nest a thousand is not a message.
 */
const MAX_DEPTH = 6;

export function renderMarkdown(text: string): string {
	const out: string[] = [];
	let fenced: string[] | null = null;

	for (const line of text.split("\n")) {
		if (FENCE.test(line)) {
			if (fenced) {
				out.push(fence(fenced));
				fenced = null;
			} else {
				fenced = [];
			}
			continue;
		}

		if (fenced) {
			fenced.push(line);
			continue;
		}

		out.push(renderLine(line));
	}

	// A fence that never closes is a message that was cut short, not a reason to
	// drop everything after the last backticks.
	if (fenced) out.push(fence(fenced));

	return out.join("\n");
}

const fence = (lines: string[]) =>
	`<code class="md-fence">${escapeHtml(lines.join("\n"))}</code>`;

function renderLine(line: string): string {
	if (RULE.test(line)) return '<span class="md-rule" aria-hidden="true"></span>';

	const heading = HEADING.exec(line);
	if (heading) {
		const level = heading[1]!.length;
		return `<span class="md-h md-h${level}">${renderInline(heading[2] ?? "")}</span>`;
	}

	const quote = QUOTE.exec(line);
	if (quote) {
		// The marker is kept. It is the only thing left saying where the quote
		// ends, in a pane that cannot draw a rule down the side of one.
		return `<span class="md-quote">${escapeHtml(quote[1] ?? "")}${renderInline(quote[2] ?? "")}</span>`;
	}

	const bullet = BULLET.exec(line);
	if (bullet) {
		return `${bullet[1]}<span class="md-marker">${escapeHtml(bullet[2]!)}</span> ${renderInline(bullet[3] ?? "")}`;
	}

	return renderInline(line);
}

/**
 * `autolink` is off inside a link's own words: a bare URL there would be turned
 * into a second anchor inside the first, which is not markup a browser can
 * make sense of. It is exactly the case `[](https://…)` produces, since an
 * empty label falls back to showing the target.
 */
function renderInline(text: string, depth = 0, autolink = true): string {
	const plain = (value: string) => (autolink ? linkify(value) : escapeHtml(value));
	if (depth >= MAX_DEPTH) return plain(text);

	let out = "";
	let at = 0;

	for (const match of text.matchAll(INLINE)) {
		const index = match.index ?? 0;
		out += plain(text.slice(at, index));

		if (match[1] !== undefined) {
			out += `<code>${escapeHtml(match[1])}</code>`;
		} else if (match[4] !== undefined) {
			out += target(match[2] === "!", match[3] ?? "", match[4], match[0], depth);
		} else if (match[5] !== undefined) {
			out += `<strong>${renderInline(match[5], depth + 1, autolink)}</strong>`;
		} else if (match[6] !== undefined) {
			out += `<em>${renderInline(match[6], depth + 1, autolink)}</em>`;
		}

		at = index + match[0].length;
	}

	return out + plain(text.slice(at));
}

/**
 * An image or a link, or neither.
 *
 * A refused *image* falls back to its alt text, which is all it ever said. A
 * refused *link* is left as the text it was written as: a reader being shown
 * something odd is better off seeing where it claimed to point, and it cannot
 * be clicked.
 */
function target(
	image: boolean,
	label: string,
	href: string,
	raw: string,
	depth: number,
): string {
	if (image) {
		return FETCHABLE.test(href)
			? `<img class="body-image" src="${escapeHtml(href)}" alt="${escapeHtml(label)}" loading="lazy">`
			: escapeHtml(label);
	}

	if (!FOLLOWABLE.test(href)) return escapeHtml(raw);

	const words = label ? renderInline(label, depth + 1, false) : escapeHtml(href);
	return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${words}</a>`;
}
