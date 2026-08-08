import { isTauri } from "../api/platform";

/**
 * Registers the service worker, so the browser client boots without a network.
 *
 * Not in the shells. The desktop and Android clients load the whole client out
 * of the binary — there is no network fetch to intercept, `tauri://localhost`
 * is not an origin a worker can usefully cache, and registering one there
 * inserts a cache between the app and assets it already has on disk. Their
 * offline story is a different and better one: the server is on the same
 * device, and its maildir is local.
 *
 * Not over http, either — a service worker is a secure-context feature, so this
 * simply does nothing when ecr is served over plain http on a hostname. That is
 * a real deployment (a server on a LAN) and it must keep working, which is why
 * every failure here is swallowed rather than reported: nothing about the
 * client depends on this succeeding.
 */
export function registerServiceWorker(): void {
	if (isTauri()) return;
	if (!("serviceWorker" in navigator)) return;

	// Registered after load rather than during boot. The worker's install
	// fetches the shell, and racing that against the client's first request for
	// mail costs the reader the thing they opened the app for.
	// `once`, because `load` can fire again — a bfcache restore is the ordinary
	// case — and a second registration of the same script is a wasted install
	// that re-fetches the shell behind a client that is already running.
	window.addEventListener(
		"load",
		() => {
			navigator.serviceWorker.register("/sw.js").catch(() => {
				// An http origin, a browser with workers disabled, a profile in
				// private mode. None of them is a problem to report: the client
				// works exactly as it did before this existed.
			});
		},
		{ once: true },
	);
}

/**
 * Whether the browser currently believes it has a network.
 *
 * `navigator.onLine` is famously weak — it answers true for a machine attached
 * to a router that reaches nothing — so it is used for the one thing it is
 * reliable at: `false` means definitely not connected. The client's real
 * signal for whether *its server* is there is `store.health`, which asks the
 * server. This is only ever an extra sentence beside that.
 */
export function isOffline(): boolean {
	return typeof navigator !== "undefined" && navigator.onLine === false;
}
