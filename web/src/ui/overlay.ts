import type { Span } from "../keymap/motions";

export type RunKind = "plain" | "selection" | "cursor";

export interface Run {
  text: string;
  kind: RunKind;
}

/**
 * Splits a buffer into the runs a block cursor needs painting behind it. A
 * textarea has no caret shape and can show only one selection, so normal and
 * visual mode are drawn by a mirror layer instead; this is the part of that
 * worth testing.
 *
 * The cursor sits *on* a character. Where there is none to sit on — the end of
 * the buffer, or a line break — it becomes a synthetic space, so the block is
 * still visible.
 */
export function overlayRuns(text: string, caret: number, selection: Span | null): Run[] {
  const at = Math.max(0, Math.min(caret, text.length));
  const synthetic = at >= text.length || text[at] === "\n";
  const cursor: Span | null = synthetic ? null : { from: at, to: at + 1 };

  const bounds = new Set<number>([0, text.length, at]);
  if (selection) {
    bounds.add(Math.max(0, Math.min(selection.from, text.length)));
    bounds.add(Math.max(0, Math.min(selection.to, text.length)));
  }
  if (cursor) bounds.add(cursor.to);

  const points = [...bounds].sort((a, b) => a - b);
  const runs: Run[] = [];

  const push = (value: string, kind: RunKind) => {
    if (value === "") return;
    const last = runs.at(-1);
    if (last && last.kind === kind) last.text += value;
    else runs.push({ text: value, kind });
  };

  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!;
    const to = points[i + 1]!;

    if (synthetic && from === at) push(" ", "cursor");

    const kind: RunKind =
      cursor && from >= cursor.from && to <= cursor.to
        ? "cursor"
        : selection && from >= selection.from && to <= selection.to
          ? "selection"
          : "plain";

    push(text.slice(from, to), kind);
  }

  if (synthetic && at === text.length) push(" ", "cursor");

  return runs;
}
