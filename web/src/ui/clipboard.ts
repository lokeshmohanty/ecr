/**
 * Copying text, on an origin the browser trusts and on one it does not.
 *
 * `navigator.clipboard` is a secure-context API, so on `http://mail.lan:8383`
 * it is not there at all — and the call sites guarded that with `?.`, which
 * turns a missing feature into a `y` that reports a yank and copies nothing.
 * The guard was right about not throwing and wrong about stopping there.
 *
 * `document.execCommand("copy")` is deprecated and works everywhere, including
 * on a plain-HTTP origin, because it is gated on a user gesture rather than on
 * the origin. A keystroke *is* a user gesture, which is exactly the case here:
 * every caller is a key the reader pressed. So it is the fallback, and it is
 * the only reason the vim yank works at all outside loopback.
 *
 * The async path is still preferred where it exists — it is the one that
 * survives the deprecation, and it does not need a detached element in the
 * document to work.
 */
export function copyText(text: string): boolean {
	if (text === "") return false;

	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		// Fire and forget: the promise resolves after the frame this was called
		// in, and a yank that waited for it would be a keystroke that blocks.
		// A rejection falls through to the same place a missing API does.
		navigator.clipboard.writeText(text).catch(() => {
			legacyCopy(text);
		});
		return true;
	}

	return legacyCopy(text);
}

/**
 * The textarea is off-screen rather than `display: none`, because a box that
 * is not laid out cannot be selected and the copy silently does nothing.
 * `readonly` keeps a soft keyboard from opening on a phone the instant
 * anything is yanked.
 */
function legacyCopy(text: string): boolean {
	if (typeof document === "undefined" || !document.body) return false;

	const held = document.activeElement as HTMLElement | null;
	const carrier = document.createElement("textarea");
	carrier.value = text;
	carrier.setAttribute("readonly", "");
	carrier.setAttribute("aria-hidden", "true");
	carrier.style.position = "fixed";
	carrier.style.top = "0";
	carrier.style.left = "-9999px";
	carrier.style.opacity = "0";

	document.body.appendChild(carrier);
	try {
		carrier.select();
		carrier.setSelectionRange(0, text.length);
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		carrier.remove();
		// The composer and view mode both yank from a surface that owns the
		// keyboard; leaving focus on a removed node hands the next keystroke to
		// the document and the pane goes inert.
		held?.focus?.();
	}
}
