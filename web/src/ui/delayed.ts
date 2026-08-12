import { createEffect, createSignal, onCleanup } from "solid-js";

/**
 * How long something must be pending before it is worth saying so.
 *
 * A warm body arrives in about twelve milliseconds. Painting *loading…* for
 * twelve milliseconds is not information, it is a flash — and a flash reads as
 * a stutter, so the affordance made the fast path look broken while claiming to
 * explain the slow one. Under this threshold the UI simply swaps content, the
 * way a terminal does.
 */
const SHOW_AFTER = 200;

/**
 * Once shown, the least time it stays.
 *
 * Without it a request landing at 210ms would put the word on screen for ten
 * milliseconds, which is the same flash one threshold later.
 */
const MIN_VISIBLE = 300;

/**
 * True only when `pending` has held for long enough to be worth reporting.
 *
 * The delay and the floor are both about the same thing: an indicator that
 * appears and vanishes faster than the eye can resolve it costs more than it
 * explains.
 */
export function createDelayed(
	pending: () => boolean,
	showAfter = SHOW_AFTER,
	minVisible = MIN_VISIBLE,
): () => boolean {
	const [shown, setShown] = createSignal(false);
	// Deliberately not a signal: reading it inside the effect would make the
	// effect depend on its own output and re-run on every change.
	let shownAt = 0;

	createEffect(() => {
		if (pending()) {
			const timer = setTimeout(() => {
				shownAt = Date.now();
				setShown(true);
			}, showAfter);
			onCleanup(() => clearTimeout(timer));
			return;
		}

		const remaining = minVisible - (Date.now() - shownAt);
		if (remaining <= 0) {
			setShown(false);
			return;
		}

		const timer = setTimeout(() => setShown(false), remaining);
		onCleanup(() => clearTimeout(timer));
	});

	return shown;
}
