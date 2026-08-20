/**
 * What a plain-HTTP origin cannot do, named in one place.
 *
 * A self-hosted mail server is reached at `http://localhost:8383` from the
 * machine it runs on and at `http://something.lan:8383` from anywhere else,
 * and the browser treats those two as different kinds of place. Loopback is a
 * *secure context* by definition; the second is not, and on it the platform
 * quietly withdraws four things: installing the app, service workers,
 * notifications, and the async clipboard.
 *
 * Quietly is the problem. Each one fails by being absent rather than by
 * refusing, so *announce new mail* is a switch that does nothing, `y` copies
 * nothing, and there is no install button anywhere — with nothing on screen
 * connecting any of it to the scheme in the address bar. A reader concludes
 * the feature is broken, which is a worse answer than the true one.
 *
 * So the client asks once and can say so. Nothing here changes behaviour on
 * its own: the clipboard has a fallback that works either way, notifications
 * already refuse silently, and the service worker already declines to
 * register. This is the explanation, not the mechanism.
 */

export type Restricted = "install" | "offline" | "notifications" | "clipboard";

/**
 * Whether the page is in a secure context.
 *
 * `window.isSecureContext` is the browser's own answer and is the only one
 * worth having — guessing from the protocol gets loopback wrong, and loopback
 * is how ecr is reached on the machine that serves it.
 */
export function isSecure(): boolean {
	if (typeof window === "undefined") return true;
	return window.isSecureContext !== false;
}

/** What is unavailable here, in the order a reader would miss it. */
export function restricted(): Restricted[] {
	if (isSecure()) return [];
	return ["install", "offline", "notifications", "clipboard"];
}

const WHY: Record<Restricted, string> = {
	install: "installing ecr as an app",
	offline: "starting without a network",
	notifications: "notifications for new mail",
	clipboard: "copying to the system clipboard",
};

/**
 * One sentence for the settings page, or `null` when there is nothing to say.
 *
 * Both remedies are named because they suit different setups: a tailnet can be
 * given a real certificate, and a machine on a LAN is often easier to fix at
 * the browser, which is what the flag is for. Neither is a workaround for a
 * broken client — the restriction is the browser's policy about the *origin*,
 * and it applies to every site reached this way.
 */
export function insecureOriginNotice(): string | null {
	const missing = restricted();
	if (missing.length === 0) return null;

	const list = missing.map((item) => WHY[item]).join(", ");
	return (
		`This address is plain HTTP, so the browser withholds ${list}. ` +
		`Reach ecr over HTTPS — \`tailscale cert\` issues one for a tailnet — or ` +
		`tell your browser to trust this origin: Chromium's ` +
		`--unsafely-treat-insecure-origin-as-secure takes the address as written. ` +
		`http://localhost and http://127.0.0.1 are already trusted, so none of ` +
		`this applies on the machine running the server.`
	);
}
