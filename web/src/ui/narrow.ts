import { createSignal } from "solid-js";

/**
 * Whether the app is showing one pane at a time rather than side by side.
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

/** The last width at which one pane fills the screen — Tailwind's `md`, less one. */
export const PHONE_MAX = 767;

export type Layout = "stacked" | "two" | "three";

/**
 * How many panes fit, given the window and the width this device asks for.
 *
 * The phone's line is fixed at `md`, because that same breakpoint decides the
 * action bar, the plain-text composer, the swipe gestures and the safe-area
 * insets — those answer "is this a touch phone", not "how many columns fit",
 * and a setting that moved one without the others would leave a stacked client
 * with a desktop's composer in it.
 *
 * The sidebar's line is a setting, so it is rendered from rather than compiled
 * in. Both ends of its range are meaningful rather than invalid: a width below
 * the phone line means three panes wherever there is more than one, and one
 * above any real screen means the sidebar is always a drawer.
 */
export function layoutFor(width: number, sidebarMinWidth: number): Layout {
  if (width <= PHONE_MAX) return "stacked";
  return width >= sidebarMinWidth ? "three" : "two";
}

const [width, setWidth] = createSignal(
  typeof window === "undefined" ? 1440 : window.innerWidth,
);

if (typeof window !== "undefined")
  window.addEventListener("resize", () => setWidth(window.innerWidth));

/**
 * The window's width, as a signal.
 *
 * `isNarrow` can be a plain function because the phone's line is a CSS
 * breakpoint: the layout follows it whether or not anything re-renders. The
 * sidebar's line is a number a reader chose, so the layout is *rendered* from
 * it and has to wake when the window changes. `innerWidth` rather than
 * `clientWidth` because it counts the scrollbar the way a media query does, and
 * the two lines meet at 768.
 */
export const viewportWidth = width;
