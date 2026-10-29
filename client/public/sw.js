// Service worker: makes Dogfight installable and lets the shell (page,
// script, sprites, sounds) load instantly on the next visit. The game itself
// needs the server, so /api, /ws and the health endpoints are never cached.
const CACHE = "dogfight-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

const LIVE = /^\/(api|ws|health|ready|metrics)(\/|$)/;

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || LIVE.test(url.pathname)) return;

  // Pages: network first, so a deploy shows up at once; the cache is the offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(() => caches.match("/").then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Everything else: answer from the cache, refresh it in the background.
  // Vite's bundles carry a content hash, so for them the refresh never changes
  // anything; arena.json, sprites and sounds pick up a deploy one visit later.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request).then((response) => {
        if (response.ok) void cache.put(request, response.clone());
        return response;
      });
      if (!cached) return network;
      event.waitUntil(network.catch(() => undefined));
      return cached;
    }),
  );
});
