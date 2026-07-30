export interface WindowRange {
  start: number;
  end: number;
  offset: number;
  total: number;
}

/**
 * Which slice of a uniform-height list is worth rendering.
 *
 * Deliberately hand-rolled rather than pulled from a virtualization library:
 * the range is pure arithmetic, it is trivially testable, and it does not care
 * whether the scroll container existed at mount time — which is exactly the
 * lifecycle detail that made an off-the-shelf virtualizer render nothing.
 */
export function windowRange(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 8,
): WindowRange {
  const total = count * rowHeight;

  if (count === 0 || rowHeight <= 0) {
    return { start: 0, end: 0, offset: 0, total: 0 };
  }

  // Before the container has been measured, render a first screenful rather
  // than nothing, so the list is never blank waiting on a resize observer.
  const height = viewportHeight > 0 ? viewportHeight : rowHeight * 20;

  const visible = Math.ceil(height / rowHeight) + overscan * 2;

  // Clamping the start matters when the list shrinks under a scrolled
  // viewport — a narrowed search, say. Without it the window can start past
  // the end and render nothing at all.
  const maxStart = Math.max(0, count - visible);
  const first = Math.min(
    maxStart,
    Math.max(0, Math.floor(scrollTop / rowHeight) - overscan),
  );
  const last = Math.min(count, first + visible);

  return { start: first, end: last, offset: first * rowHeight, total };
}
