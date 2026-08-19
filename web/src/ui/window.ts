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

/**
 * Where every entry starts, and where the list ends.
 *
 * The uniform version above cannot survive a day separator: `index * pitch` is
 * the whole of it, and one taller row makes every offset below it a lie —
 * which is the compounding error the row card's gap is inside the pitch to
 * avoid. So a list with headings in it is measured by a prefix sum instead,
 * computed once per page rather than per scroll: `offsets[i]` is the top of
 * entry `i` and the last element is the height of the whole list.
 *
 * It is still pure arithmetic over numbers the caller already knows. Nothing
 * here reads the DOM, so a heading and a row can differ in height without
 * anything having to be measured.
 */
export function offsetsOf(heights: number[]): number[] {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < heights.length; i += 1)
    offsets[i + 1] = offsets[i]! + heights[i]!;
  return offsets;
}

/**
 * The first entry at or below `y`.
 *
 * Binary search rather than a scan: this runs on every scroll event, and a
 * page of fifty is not where it matters — a query answering ten thousand rows
 * is, and a scan there is ten thousand comparisons a frame.
 */
export function entryAt(offsets: number[], y: number): number {
  let low = 0;
  let high = offsets.length - 2;

  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid]! <= y) low = mid;
    else high = mid - 1;
  }

  return low;
}

/**
 * Which slice of a list of *varying* heights is worth rendering.
 *
 * Same contract as `windowRange`: `offset` is where the rendered slab is
 * translated to, `total` is the height the scrollbar is sized by. The overscan
 * is in entries rather than pixels, so a screenful plus eight either side, the
 * way it always was.
 */
export function windowSlice(
  offsets: number[],
  scrollTop: number,
  viewportHeight: number,
  overscan = 8,
): WindowRange {
  const count = offsets.length - 1;
  const total = count > 0 ? offsets[count]! : 0;

  if (count <= 0) return { start: 0, end: 0, offset: 0, total: 0 };

  // Before the container has been measured, a screenful is unknowable — render
  // enough that the list is never blank waiting on a resize observer.
  const height = viewportHeight > 0 ? viewportHeight : total;

  const first = Math.max(0, entryAt(offsets, scrollTop) - overscan);
  const last = Math.min(count, entryAt(offsets, scrollTop + height) + 1 + overscan);

  return { start: first, end: last, offset: offsets[first]!, total };
}
