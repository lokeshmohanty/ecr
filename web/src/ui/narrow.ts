/**
 * Whether the app is showing one pane at a time rather than three side by side.
 *
 * The breakpoint is the one the `md:` utilities switch on, so this and the
 * layout can never disagree about what a phone is. It is a function, not a
 * signal: every caller reads it at the moment of an action, and nothing renders
 * from it.
 */
export function isNarrow(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(max-width: 767px)").matches === true
  );
}
