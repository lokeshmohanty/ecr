/**
 * The touch gestures a list row answers to, as arithmetic over touch points.
 *
 * Kept apart from the component for the same reason the vim motions are: a
 * gesture is a decision about distances and timings, and deciding it in a
 * handler means it can only ever be checked by hand on a real phone.
 */

/** Past this much sideways travel, the row is being swiped rather than scrolled. */
export const SWIPE_COMMIT = 96;

/**
 * Below this the gesture is ambiguous, so nothing moves yet. Committing sooner
 * turns every imprecise scroll into an archive.
 */
const SWIPE_START = 12;

/** How long a finger must rest before it means "pick this", in milliseconds. */
export const LONG_PRESS = 450;

/** A finger that has moved this far is scrolling, and cancels the long press. */
const LONG_PRESS_SLOP = 10;

export type Swipe = "archive" | "flag" | null;

export interface Drag {
  /** How far the row should be drawn from its resting place. */
  offset: number;
  /** What would happen if the finger lifted now. */
  commit: Swipe;
  /** True once sideways travel has won, so the list must stop scrolling. */
  horizontal: boolean;
}

/**
 * What a finger at `(dx, dy)` from where it started means.
 *
 * Vertical wins ties: a list is scrolled far more often than a row is swiped,
 * so an ambiguous drag has to keep scrolling rather than start sliding a row.
 */
export function drag(dx: number, dy: number): Drag {
  const horizontal = Math.abs(dx) > SWIPE_START && Math.abs(dx) > Math.abs(dy);
  if (!horizontal) return { offset: 0, commit: null, horizontal: false };

  // Resistance past the commit point: the row keeps answering the finger, but
  // stops promising that further travel does anything more.
  const past = Math.max(Math.abs(dx) - SWIPE_COMMIT, 0);
  const magnitude = Math.min(Math.abs(dx), SWIPE_COMMIT) + past * 0.2;

  return {
    offset: Math.sign(dx) * magnitude,
    commit: Math.abs(dx) >= SWIPE_COMMIT ? (dx < 0 ? "archive" : "flag") : null,
    horizontal: true,
  };
}

/** Whether a press that has travelled this far still counts as a long press. */
export function stillPressing(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) <= LONG_PRESS_SLOP;
}
