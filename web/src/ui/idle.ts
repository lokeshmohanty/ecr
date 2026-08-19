/**
 * Getting out of the way of the next keystroke.
 *
 * Opening a thread is the most expensive thing this client does: a fetch, a
 * pane rebuilt, and one sandboxed document per message parsed and laid out. It
 * is scheduled off a cursor movement, so all of it used to land in the same
 * task as the `j` that caused it — the row repaint and the thread open shared
 * one frame, and the frame took as long as the thread. Holding `j` then felt
 * like the cursor was being dragged rather than moved.
 *
 * `afterPaint` splits them. The frame that moves the cursor is allowed to
 * finish and reach the screen; the work that follows starts in a task of its
 * own, where the next keystroke can pre-empt it by cancelling.
 *
 * `requestIdleCallback` is deliberately not used. WebKitGTK does not implement
 * it — the desktop shell is WebKitGTK — so it would be the one platform where
 * the fix quietly did nothing, which is worse than not having it. A frame plus
 * a task is available everywhere and is the ordering that actually matters.
 */
export function afterPaint(run: () => void): () => void {
	if (typeof requestAnimationFrame !== "function") {
		const timer = setTimeout(run, 0) as unknown as number;
		return () => clearTimeout(timer);
	}

	let timer: number | undefined;
	const frame = requestAnimationFrame(() => {
		timer = setTimeout(run, 0) as unknown as number;
	});

	return () => {
		cancelAnimationFrame(frame);
		if (timer !== undefined) clearTimeout(timer);
	};
}
