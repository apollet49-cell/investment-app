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
const CACHE_VERSION = "investapp-v11";
// Pre-cache only "/" (index.html) — it's the app entry and we want offline
// support for the shell. NOT app.js / style.css / i18n.js: those are static
// imports inside view modules (`import { loadChartJs } from "/static/app.js"`)
// which use the un-versioned URL. If we cache the un-versioned URL, deploys
// don't invalidate it and view modules end up importing a stale shell that
// doesn't export new symbols — bug we shipped in v4 where the FIRE page
// crashed with "Unexpected identifier 'loadChartJs'".
// View modules ARE pre-cached because index.html requests them with ?v=N,
// so a deploy bumps the URL and the cached old one becomes unreachable.
const SHELL_URLS = ["/"];
const VIEW_URLS = [
  "/static/views/dashboard.js",
  "/static/views/investments.js",
  "/static/views/review.js",
  "/static/views/fire.js",
  "/static/views/transactions.js",
];
// Un-versioned static assets that view modules import directly. We use
// network-first for these so a deploy lands within the next request,
// with cache as offline fallback only.
const NETWORK_FIRST_PATHS = [
  "/static/app.js",
  "/static/i18n.js",
  "/static/style.css",
  "/static/landing.css",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // addAll bails if any URL fails — wrap each so a 404 on, say,
      // /static/app.js?v=N (because the SW upgraded after a deploy)
      // doesn't prevent the SW from installing.
      Promise.all(
        [...SHELL_URLS, ...VIEW_URLS].map((url) =>
          cache.add(url).catch((e) => console.warn("[sw] precache skip", url, e))
        )
      )
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
    "/market/", "/alerts", "/scenarios", "/exports/",
    "/planning/", "/rebalance", "/tax/", "/dividends/",
    "/calculator/", "/config/", "/settings/", "/health",
  ];
  if (dynamicPrefixes.some((p) => url.pathname.startsWith(p))) {
    return; // default network fetch
  }

  // Un-versioned static (app.js, i18n.js, style.css): network-first so
  // deploys land immediately; cache only as offline fallback.
  const isNetworkFirst = NETWORK_FIRST_PATHS.includes(url.pathname);
  if (isNetworkFirst) {
    event.respondWith(
      fetch(req).then((fresh) => {
        if (fresh.ok) {
          const copy = fresh.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return fresh;
      }).catch(() => caches.match(req).then((c) => c || caches.match("/")))
    );
    return;
  }

  // Everything else (versioned views, the "/" shell) — cache-first SWR.
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
