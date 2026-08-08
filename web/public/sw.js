/*
 * The service worker: what the browser client does when the server is not
 * there.
 *
 * It caches **the application and nothing else**. Not one byte of mail, not one
 * API response. That is the whole design, and it is a decision rather than an
 * omission:
 *
 * A cached `/api/v1/threads` served while offline is a thread list that looks
 * current and is not — mail that has been read, filed or deleted, presented
 * with no way to tell. The client already has a much better answer for a server
 * it cannot reach: it says so, beside the address and a retry button. Caching
 * would replace a truthful empty pane with a convincing stale one.
 *
 * And every API response here is somebody's mail, fetched with a bearer token.
 * Putting it in Cache Storage writes it to disk in the browser profile, where
 * it outlives the tab, survives a logout the client knows nothing about, and is
 * readable by anything else that runs on the origin. A mail client should not
 * be the reason a shared laptop has a stranger's inbox on it.
 *
 * So what this buys is precise and worth having on its own: **the app boots
 * without a network.** Without it, opening ecr on a phone with no signal gets
 * the browser's own error page, which says nothing about ecr and offers
 * nothing to do. With it, the client loads, finds no server, and shows its own
 * account of that — which is a screen somebody can act on.
 *
 * Reading mail offline is the desktop and Android clients' job, and they
 * already do it: they talk to a server on the same device, whose maildir is
 * local. That is a real offline mode rather than a copy of one.
 */

// Bumping this is how an old cache is retired. Every entry is a build artefact
// with a hashed name, so the only thing a stale cache costs is disk — but a
// cached `index.html` pointing at assets that no longer exist is a white page,
// which is why the document is never served from cache while a network is
// answering.
const CACHE = "ecr-shell-v1";

/*
 * The document, so there is something to boot. Assets are not listed: they are
 * hashed at build time and naming them here would mean generating this file,
 * and a precache manifest that drifts from the build fails as an install that
 * silently does nothing.
 */
const SHELL = ["/", "/index.html"];

self.addEventListener("install", (event) => {
  // Take over immediately rather than waiting for every tab to close. A client
  // that has to be fully quit before it can start offline is one nobody
  // discovers works offline.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => undefined)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Anything that is not a plain same-origin GET is passed straight through
  // and never seen again. That covers every write, and it covers the API by
  // the check below.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /*
   * The API is mail. It is never cached, never served from cache, and never
   * even inspected — a `respondWith` that fell through to the network on a
   * miss would still put this worker in the path of every authenticated
   * request, which is a place a bug becomes an outage.
   */
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(handle(request));
});

async function handle(request) {
  const cache = await caches.open(CACHE);

  /*
   * The document goes to the network first. It names the hashed assets, so a
   * stale copy points at files that were deleted by the deploy that replaced
   * them — a white page with a console full of 404s, which reads as the app
   * being broken rather than as a cache that needs clearing. Cache is the
   * fallback, which is exactly the offline case.
   */
  if (request.mode === "navigate") {
    try {
      const fresh = await fetch(request);
      // Only a real answer. A 404 or a 502 from a misconfigured proxy cached
      // as the shell is an app that stays broken after the proxy is fixed.
      if (fresh.ok) cache.put("/index.html", fresh.clone());
      return fresh;
    } catch {
      const cached = (await cache.match("/index.html")) ?? (await cache.match("/"));
      // Without this the browser's own error page appears, which says nothing
      // about ecr and offers nothing to do.
      return cached ?? Response.error();
    }
  }

  /*
   * Everything else — scripts, styles, fonts — is content-hashed by the build,
   * so a URL that matches is byte-identical by construction and can be served
   * from cache without checking. The revalidation behind it is what picks up a
   * file whose name did not change, which is the un-hashed handful in
   * `public/`.
   */
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);

  return cached ?? (await network) ?? Response.error();
}
