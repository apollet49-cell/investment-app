/* InvestApp Service Worker — cache the app shell, never cache API calls.
 *
 * Strategy:
 *   - install: pre-cache the minimal shell so the page boots offline.
 *   - fetch:   cache-first for /static/* (versioned via ?v=N — when the
 *              shell bumps, the URLs are new so we naturally miss);
 *              network-only for /auth, /api, /market, /dashboard,
 *              /investments, /chat, /transactions, /alerts (all dynamic).
 *
 * Bump CACHE_VERSION whenever the shell changes shape. Old caches are
 * deleted on activate.
 */
const CACHE_VERSION = "investapp-v3";
const SHELL_URLS = [
  "/",
  "/static/style.css",
  "/static/app.js",
  "/static/i18n.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // addAll bails if any URL fails — wrap each so a 404 on, say,
      // /static/app.js?v=N (because the SW upgraded after a deploy)
      // doesn't prevent the SW from installing.
      Promise.all(SHELL_URLS.map((url) =>
        cache.add(url).catch((e) => console.warn("[sw] precache skip", url, e))
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Only handle same-origin (don't break CDN requests to jsdelivr/unpkg).
  if (url.origin !== self.location.origin) return;

  // Dynamic endpoints — always go to the network. Listing all the
  // dynamic prefixes is more robust than trying to derive them from
  // /static/* because /config/public and /health aren't under /api.
  const dynamicPrefixes = [
    "/auth/", "/dashboard/", "/investments/", "/transactions",
    "/market/", "/chat/", "/alerts", "/scenarios", "/exports/",
    "/planning/", "/plans", "/rebalance", "/tax/", "/dividends/",
    "/wallet/", "/watchlist/", "/calculator/", "/config/",
    "/markets/", "/auth", "/settings/", "/health",
  ];
  if (dynamicPrefixes.some((p) => url.pathname.startsWith(p))) {
    return; // default network fetch
  }

  // Shell + static — cache-first.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Refresh in background so the next visit gets the latest.
        fetch(req).then((fresh) => {
          if (fresh.ok) caches.open(CACHE_VERSION).then((c) => c.put(req, fresh.clone()));
        }).catch(() => {});
        return cached;
      }
      return fetch(req).then((fresh) => {
        if (fresh.ok && (url.pathname.startsWith("/static/") || url.pathname === "/")) {
          const copy = fresh.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return fresh;
      }).catch(() => caches.match("/")); // offline → app shell fallback
    })
  );
});
