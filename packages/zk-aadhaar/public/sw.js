// Offline cache for the static app shell. Same-origin GET requests only — the
// app never sends scanned data anywhere, so there is nothing else to intercept.
const CACHE = "zkaadhaar-static-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

// The page posts the URLs it (and its decoder worker) loaded, so the very first
// visit already caches everything needed to work offline.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "precache" || !Array.isArray(data.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        data.urls
          .filter((url) => typeof url === "string" && new URL(url).origin === self.location.origin)
          .map(async (url) => {
            if (await cache.match(url)) return;
            try {
              const response = await fetch(url, { cache: "no-cache" });
              if (response.ok) await cache.put(url, response);
            } catch {
              /* offline or gone; skip */
            }
          }),
      );
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    // Network first so new deployments show up; cached shell when offline.
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const response = await fetch(request);
          if (response.ok) await cache.put(url.origin + url.pathname, response.clone());
          return response;
        } catch {
          return (
            (await cache.match(url.origin + url.pathname)) ??
            (await cache.match(request, { ignoreSearch: true })) ??
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  // Static assets are content-hashed or versioned: cache first, then network.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") await cache.put(request, response.clone());
      return response;
    })(),
  );
});
