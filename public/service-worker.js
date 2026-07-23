const CACHE = "marketlab-cloud-v2.2.1";
const STATIC_PATHS = [
  "/history.js",
  "/trading.js",
  "/performance.js",
  "/insights.js",
  "/multiuser.js",
  "/multiuser.css",
  "/manifest.webmanifest",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(STATIC_PATHS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname === "/login" || url.pathname === "/logout") return;

  // Always fetch navigations from the Worker so authentication and the active user are current.
  if (event.request.mode === "navigate") return;

  if (!STATIC_PATHS.includes(url.pathname) && !url.pathname.startsWith("/icon")) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
