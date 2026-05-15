// Single-page app entry point. Hash-based router, module-level state, JSON API
// wrapper that injects the JWT and handles 401 once. View modules are lazy-loaded.
import { t, getLang, setLang, availableLangs } from "/static/i18n.js";

export const state = {
  user: null,
  token: localStorage.getItem("token") || null,
  theme: localStorage.getItem("theme") || "light",
  charts: {},               // { name: Chart.js instance, destroyed on view change }
  sse: null,                // EventSource
  lastPrices: new Map(),    // for flash animations
  fxRate: 1.0,              // USD → user.currency multiplier (1.0 when user.currency == "USD")
  fxFetchedAt: null,
};

const API = {
  base: "",
  async request(path, opts = {}) {
    const headers = new Headers(opts.headers || {});
    if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
    if (opts.body && !(opts.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const body = opts.body && !(opts.body instanceof FormData) && typeof opts.body !== "string"
      ? JSON.stringify(opts.body)
      : opts.body;
    const res = await fetch(this.base + path, { ...opts, headers, body });
    if (res.status === 401) {
      logout();
      throw new Error("session expired");
    }
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch (_) {}
      throw new Error(detail);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return res.json();
    if (ct.includes("text/")) return res.text();
    return res.blob();
  },
};

export { API };

// Stale-while-revalidate GET helper. Backed by IndexedDB (with an
// in-memory + sessionStorage fast path) so the cache survives tab close
// and full-page reloads. Each entry has a 24h TTL — beyond that we fall
// back to network so the user doesn't see a dashboard from two weeks ago.
//
// Layered cache lookup:
//   1. In-memory Map (zero-latency for the current session)
//   2. sessionStorage (synchronous, survives soft reload)
//   3. IndexedDB (asynchronous, survives tab close & browser restart)
//   4. Network
//
// Request deduplication: when N concurrent callers ask for the same
// uncached path (e.g. dashboard.js calling loadPerformance +
// loadHistoryAndBenchmark in parallel), only ONE fetch goes over the
// wire — others await the shared promise.
//
// Cache is scoped to the JWT so two users sharing a browser don't bleed.
const _inflight = new Map();
const _memCache = new Map();
const SWR_TTL_MS = 24 * 60 * 60 * 1000;

// Tiny IndexedDB wrapper (no library — keeps the bundle small).
const _IDB_NAME = "investapp-swr";
const _IDB_STORE = "swr";
let _idbPromise = null;
function _openIdb() {
  if (_idbPromise) return _idbPromise;
  if (!("indexedDB" in window)) return Promise.resolve(null);
  _idbPromise = new Promise((resolve) => {
    const req = indexedDB.open(_IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(_IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null); // fail-open: degrade to sessionStorage
  });
  return _idbPromise;
}
async function _idbGet(key) {
  const db = await _openIdb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(_IDB_STORE, "readonly");
      const req = tx.objectStore(_IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}
async function _idbPut(key, value) {
  const db = await _openIdb();
  if (!db) return;
  try {
    const tx = db.transaction(_IDB_STORE, "readwrite");
    tx.objectStore(_IDB_STORE).put(value, key);
  } catch (_) { /* quota / closed db — ignore */ }
}
async function _idbDeleteWhere(predicate) {
  const db = await _openIdb();
  if (!db) return;
  try {
    const tx = db.transaction(_IDB_STORE, "readwrite");
    const store = tx.objectStore(_IDB_STORE);
    store.openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      if (predicate(cursor.key)) cursor.delete();
      cursor.continue();
    };
  } catch (_) {}
}

function _swrKey(path) {
  return `swr:${state.token?.slice(-12) || "anon"}:${path}`;
}

function _isFresh(entry) {
  return entry && entry.value !== undefined && (Date.now() - (entry.at || 0)) < SWR_TTL_MS;
}

function _readSync(key) {
  // In-memory first (no parse), then sessionStorage (synchronous, parsed once).
  if (_memCache.has(key)) return _memCache.get(key);
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw);
    _memCache.set(key, entry);
    return entry;
  } catch (_) { return null; }
}

function _writeAll(key, value) {
  const entry = { value, at: Date.now() };
  _memCache.set(key, entry);
  try { sessionStorage.setItem(key, JSON.stringify(entry)); } catch (_) {}
  _idbPut(key, entry).catch(() => {});
}

// Hydrate the synchronous caches from IndexedDB at boot so the *first*
// page load after a browser restart still gets instant repeat-visit perf.
export async function hydrateSwrCache() {
  const db = await _openIdb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(_IDB_STORE, "readonly");
      const store = tx.objectStore(_IDB_STORE);
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return resolve();
        const key = cursor.key;
        const entry = cursor.value;
        if (typeof key === "string" && key.startsWith("swr:") && _isFresh(entry)) {
          _memCache.set(key, entry);
          try { sessionStorage.setItem(key, JSON.stringify(entry)); } catch (_) {}
        } else if (entry && !_isFresh(entry)) {
          cursor.delete(); // GC stale entries
        }
        cursor.continue();
      };
      req.onerror = () => resolve();
    } catch (_) { resolve(); }
  });
}

export async function cachedGet(path, onUpdate) {
  const key = _swrKey(path);
  const cached = _readSync(key);
  if (_isFresh(cached)) {
    // Fire-and-forget background refresh, deduped via the inflight map.
    if (!_inflight.has(key)) {
      const p = API.request(path).then(fresh => {
        const same = JSON.stringify(fresh) === JSON.stringify(cached.value);
        _writeAll(key, fresh);
        if (!same && typeof onUpdate === "function") {
          try { onUpdate(fresh); } catch (_) {}
        }
        return fresh;
      }).catch(() => null).finally(() => _inflight.delete(key));
      _inflight.set(key, p);
    }
    return cached.value;
  }
  // Cache miss / stale: dedupe via inflight too.
  if (_inflight.has(key)) {
    const fresh = await _inflight.get(key);
    if (fresh !== null && fresh !== undefined) return fresh;
  }
  const promise = API.request(path)
    .then(fresh => {
      _writeAll(key, fresh);
      return fresh;
    })
    .finally(() => _inflight.delete(key));
  _inflight.set(key, promise);
  return await promise;
}

export function clearSwrCache() {
  _memCache.clear();
  for (const k of Object.keys(sessionStorage)) {
    if (k.startsWith("swr:")) sessionStorage.removeItem(k);
  }
  _idbDeleteWhere(k => typeof k === "string" && k.startsWith("swr:")).catch(() => {});
}

// Fire the most-visited GETs in parallel right after login so the SWR
// cache is hot when the user navigates. Each call is fire-and-forget
// (errors swallowed silently); cachedGet() reads from sessionStorage on
// the next call. Skipped if a cache entry for that path already exists
// (avoids re-fetching when bootApp runs on page reload).
export function prewarmCache() {
  // With /dashboard/all wiring the entire dashboard in one fetch, the
  // prewarm just needs to seed the bundle once. The view will read each
  // sub-result from the SWR cache instead of firing 6 individual calls.
  const tokenSuffix = state.token?.slice(-12) || "anon";
  const prefix = `swr:${tokenSuffix}:`;
  // Skip if dashboard summary is already warm from a recent visit.
  if (sessionStorage.getItem(prefix + "/dashboard/summary")) return;
  API.request("/dashboard/all").then(bundle => {
    if (!bundle) return;
    seedCache("/dashboard/summary", bundle.summary);
    seedCache("/dashboard/performance", bundle.performance);
    seedCache("/dashboard/history?days=365&benchmark=^GSPC", bundle.history);
    seedCache("/dashboard/risk?days=180&benchmark=^GSPC", bundle.risk);
    seedCache(`/planning/fire?monthly_expenses=2500&monthly_savings=1500&expected_return_pct=7&target_multiplier=25`, bundle.fire);
    seedCache("/planning/stress-test", bundle.stress);
    seedCache("/dividends/calendar", bundle.dividends);
  }).catch(() => {});
  // Investments list is separate from /dashboard/all
  if (!sessionStorage.getItem(prefix + "/investments/")) {
    API.request("/investments/").then(data => seedCache("/investments/", data)).catch(() => {});
  }
}

// Lazy script loader. Memoised Promise so concurrent callers get the same
// load. Used to defer Chart.js and lightweight-charts (combined ~300KB
// unzipped) from the index.html <script> tags — those pulled the libs
// even on routes that don't draw any charts (Calculator, Settings,
// Transactions list, Reports). Now each chart-using view does:
//   await loadChartJs();
//   state.charts.foo = new window.Chart(ctx, { ... });
const _scriptCache = new Map();
export function loadScript(src) {
  if (_scriptCache.has(src)) return _scriptCache.get(src);
  const p = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "1") return resolve();
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => { s.dataset.loaded = "1"; resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
  _scriptCache.set(src, p);
  return p;
}
export const loadChartJs = () =>
  window.Chart ? Promise.resolve() : loadScript("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js");
export const loadLightweightCharts = () =>
  window.LightweightCharts ? Promise.resolve() : loadScript("https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js");

// Drop one or more cached paths so the next cachedGet() goes to the
// network. Call this after mutations (POST/PUT/DELETE) on a resource so
// the next view doesn't render with the stale list. Accepts prefixes —
// `invalidateCache("/investments/")` also clears `/investments/?foo=1`.
export function invalidateCache(...pathPrefixes) {
  const tokenSuffix = state.token?.slice(-12) || "anon";
  const prefix = `swr:${tokenSuffix}:`;
  const matches = (k) => {
    if (typeof k !== "string" || !k.startsWith(prefix)) return false;
    const rest = k.slice(prefix.length);
    return pathPrefixes.some(p => rest.startsWith(p));
  };
  for (const k of Array.from(_memCache.keys())) if (matches(k)) _memCache.delete(k);
  for (const k of Object.keys(sessionStorage)) if (matches(k)) sessionStorage.removeItem(k);
  _idbDeleteWhere(matches).catch(() => {});
}

// Seed the SWR cache with a value we already have in memory (e.g. from
// a /dashboard/all bundle response or right after a mutation). Avoids a
// redundant network round-trip on the next cachedGet.
export function seedCache(path, value) {
  if (value === null || value === undefined) return;
  _writeAll(_swrKey(path), value);
}

// ---------- Toast / spinner ----------
export function toast(message, type = "info", ms = 3500) {
  const host = document.getElementById("toast-host");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function spinner(big = false) {
  return `<span class="spinner ${big ? "lg" : ""}"></span>`;
}

// Skeleton placeholders — match the final layout so the page doesn't
// reflow when data lands. `shape` is one of:
//   "kpi"       — 4 KPI cards in a grid (dashboard hero)
//   "chart"     — a chart card
//   "table"     — 8 table rows
//   "list"      — 4 list rows
// Use instead of spinner() for content that's visible in <1s. Beyond 1s
// users prefer feedback that something IS loading (spinner > skeleton).
export function skeleton(shape = "kpi") {
  const bar = (w = "100%", h = "12px") => `<div class="sk-bar" style="width:${w};height:${h}"></div>`;
  if (shape === "kpi") {
    return `<div class="summary-grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
      ${Array(4).fill(`
        <div class="summary-card sk">
          ${bar("60%", "11px")}
          ${bar("80%", "26px")}
          ${bar("50%", "11px")}
        </div>`).join("")}
    </div>
    <div class="card chart-card sk-chart"></div>`;
  }
  if (shape === "chart") {
    return `<div class="card chart-card sk-chart"></div>`;
  }
  if (shape === "table") {
    return `<div class="card">
      ${Array(8).fill(`<div class="sk-row">${bar("30%")}${bar("15%")}${bar("15%")}${bar("15%")}</div>`).join("")}
    </div>`;
  }
  if (shape === "list") {
    return `<div class="card">
      ${Array(4).fill(`<div class="sk-row">${bar("50%")}${bar("30%")}</div>`).join("")}
    </div>`;
  }
  return spinner(true);
}

// ---------- FX rate (USD → user currency) ----------
// All monetary values are stored in USD on the backend; the frontend converts
// at display time using a live rate from /market/forex/USD/{currency}.
export async function loadFxRate() {
  const cur = state.user?.currency || "USD";
  if (cur === "USD") {
    state.fxRate = 1.0;
    state.fxFetchedAt = Date.now();
    state.fxFailed = false;
    return 1.0;
  }
  // Read cached FX from localStorage so non-USD users don't wait for a
  // yfinance round-trip on every cold start. FX rates move slowly (~0.5%/day
  // for major pairs); a 1h cache is fine for display formatting. We still
  // fire a background refresh so the next render is up-to-date.
  const lsKey = `fx:USD:${cur}`;
  try {
    const raw = localStorage.getItem(lsKey);
    if (raw) {
      const { rate, at } = JSON.parse(raw);
      if (isFinite(rate) && rate > 0 && Date.now() - at < 60 * 60 * 1000) {
        state.fxRate = rate;
        state.fxFetchedAt = at;
        state.fxFailed = false;
        // Background refresh — don't await, so the caller proceeds.
        API.request(`/market/forex/USD/${cur}`).then(d => {
          if (d?.rate && isFinite(d.rate) && d.rate > 0) {
            state.fxRate = d.rate;
            state.fxFetchedAt = Date.now();
            try { localStorage.setItem(lsKey, JSON.stringify({ rate: d.rate, at: Date.now() })); } catch (_) {}
          }
        }).catch(() => {});
        return rate;
      }
    }
  } catch (_) {}
  try {
    const data = await API.request(`/market/forex/USD/${cur}`);
    if (data?.rate && isFinite(data.rate) && data.rate > 0) {
      state.fxRate = data.rate;
      state.fxFetchedAt = Date.now();
      state.fxFailed = false;
      try { localStorage.setItem(lsKey, JSON.stringify({ rate: data.rate, at: Date.now() })); } catch (_) {}
      return data.rate;
    }
  } catch (e) {
    console.warn(`FX rate USD→${cur} failed, falling back to 1.0:`, e.message);
  }
  state.fxRate = 1.0;
  state.fxFailed = true;
  return 1.0;
}

// ---------- Analytics (PostHog) ----------
// Loaded lazily from /config/public after bootApp. If POSTHOG_API_KEY isn't
// set on the server, this becomes a no-op so dev/test runs aren't tracked.
let _posthogReady = false;
export function track(event, props = {}) {
  if (!_posthogReady || !window.posthog) return;
  try { window.posthog.capture(event, props); } catch (_) {}
}
async function loadPosthog() {
  try {
    const cfg = await fetch("/config/public").then(r => r.json()).catch(() => ({}));
    const ph = cfg?.posthog;
    if (!ph?.api_key) return;
    // Minimal snippet — keeps the page light, defers full SDK loading
    !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
    window.posthog.init(ph.api_key, {
      api_host: ph.host,
      person_profiles: "identified_only",
      capture_pageview: false,        // we'll send manual pageviews per route
      capture_pageleave: true,
      disable_session_recording: true,
    });
    if (state.user?.id) {
      window.posthog.identify(String(state.user.id), {
        currency: state.user.currency,
        has_anthropic_key: state.user.has_anthropic_key,
      });
    }
    _posthogReady = true;
  } catch (_) { /* analytics is best-effort */ }
}

// ---------- Authenticated download ----------
// Browsers don't add the Authorization header on a plain `<a href>` click,
// so any export endpoint behind get_current_user 401s on a vanilla link.
// This fetches with the bearer token, builds a blob, and triggers a click
// on a transient anchor so the browser presents the standard save dialog.
export async function downloadAuth(path) {
  try {
    track("export_clicked", { path });
    const res = await fetch(path, { headers: { Authorization: `Bearer ${state.token}` } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || res.statusText);
    }
    const blob = await res.blob();
    const dispo = res.headers.get("Content-Disposition") || "";
    const m = dispo.match(/filename="([^"]+)"/);
    const filename = m ? m[1] : path.split("/").pop();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (e) { toast(e.message, "error"); }
}

// ---------- Formatting ----------
export function money(value, currency) {
  const ccy = currency || state.user?.currency || "USD";
  const rate = (ccy === "USD") ? 1.0 : (state.fxRate || 1.0);
  const converted = (Number(value) || 0) * rate;
  try {
    return new Intl.NumberFormat(getLang() === "zh" ? "zh-CN" : getLang(), { style: "currency", currency: ccy, maximumFractionDigits: 2 }).format(converted);
  } catch {
    return `${ccy} ${converted.toFixed(2)}`;
  }
}
export function pct(value, signed = true) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const sign = signed ? (value > 0 ? "+" : value < 0 ? "" : "") : "";
  return `${sign}${Number(value).toFixed(2)}%`;
}

// ---------- Routing ----------
// Bump VIEW_VERSION whenever any /static/views/*.js changes so users on a
// stale tab pick up the new module on next route change. Match the value
// to ?v=N on app.js / style.css in index.html.
const VIEW_VERSION = "68";
const v = (path) => `${path}?v=${VIEW_VERSION}`;
const ROUTES = [
  { hash: "#/dashboard", titleKey: "dashboard.title", load: () => import(v("/static/views/dashboard.js")) },
  { hash: "#/investments", titleKey: "investments.title", load: () => import(v("/static/views/investments.js")) },
  { hash: "#/calculator", titleKey: "calculator.title", load: () => import(v("/static/views/calculator.js")) },
  { hash: "#/scenarios", titleKey: "scenarios.title", load: () => import(v("/static/views/scenarios.js")) },
  { hash: "#/transactions", titleKey: "transactions.title", load: () => import(v("/static/views/transactions.js")) },
  { hash: "#/rebalance", titleKey: "rebalance.title", load: () => import(v("/static/views/rebalance.js")) },
  { hash: "#/reports", titleKey: "reports.title", load: () => import(v("/static/views/reports.js")) },
  { hash: "#/tax", titleKey: "tax.title", load: () => import(v("/static/views/tax.js")) },
  { hash: "#/fire", titleKey: "fire.title", load: () => import(v("/static/views/fire.js")) },
  { hash: "#/settings", titleKey: "settings.title", load: () => import(v("/static/views/settings.js")) },
  { hash: "#/review", titleKey: "review.title", load: () => import(v("/static/views/review.js")) },
];

// Inline SVG icons (Feather/Lucide style, 1.5px stroke, currentColor so they
// follow the link's text color). Single source of truth — referenced by name
// in SIDEBAR_LINKS below.
const ICONS = {
  dashboard:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>`,
  markets:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 4 9 14 14 0 0 1-4 9 14 14 0 0 1-4-9 14 14 0 0 1 4-9z"/></svg>`,
  watchlist:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 14.85 8 21 8.9 16.5 13.5 17.7 20 12 16.85 6.3 20 7.5 13.5 3 8.9 9.15 8 12 2"/></svg>`,
  investments: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><path d="M3 13h18"/></svg>`,
  calculator:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8"/><path d="M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/></svg>`,
  scenarios:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/></svg>`,
  chat:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.2L3 21l1.8-6.4A8 8 0 1 1 21 12z"/></svg>`,
  reports:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>`,
  compare:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/><path d="M3 6 H21"/><path d="M3 6 L7 10"/><path d="M3 6 L7 2"/></svg>`,
  tax:         `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><circle cx="7" cy="7" r="2"/><circle cx="17" cy="17" r="2"/><path d="M3 3 H21 V21 H3 Z" stroke-dasharray="2,3"/></svg>`,
  fire:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14a4 4 0 0 0 8 0c0-2-1-3.5-3-5 0 2-1 3-2 3.5 0-1.5-1-2.5-1-2.5-1 1-2 2.5-2 4z"/><path d="M12 2c0 3-2 4-2 6"/></svg>`,
  transactions:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 3 21 7 17 11"/><line x1="21" y1="7" x2="9" y2="7"/><polyline points="7 21 3 17 7 13"/><line x1="3" y1="17" x2="15" y2="17"/></svg>`,
  plans:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="12" cy="15" r="2"/></svg>`,
  rebalance:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v6M7 14v6"/><path d="M4 7h6M4 17h6"/><path d="M17 4v6M17 14v6"/><path d="M14 12h6"/><circle cx="17" cy="12" r="0.5"/></svg>`,
  settings:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>`,
  sun:         `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`,
  moon:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`,
  logout:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
  review:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/><path d="M12 18 L13.6 14.5 L17 13 L13.6 11.5 L12 8 L10.4 11.5 L7 13 L10.4 14.5 Z"/></svg>`,
};

// FIRE-focused navigation. Cut from 12 to 8 items — Markets browser,
// Watchlist, DCA Plans, and Compare were 70-80% complete features that
// diluted the product story. They're still reachable by direct URL for
// power users (and their backend code still ships) but burying them from
// the sidebar lets the 8 surviving features feel coherent and finished.
const SIDEBAR_LINKS = [
  { hash: "#/dashboard",   icon: "dashboard",   labelKey: "nav.dashboard" },
  { hash: "#/investments", icon: "investments", labelKey: "nav.investments" },
  { hash: "#/transactions",icon: "transactions",labelKey: "nav.transactions" },
  { hash: "#/review",      icon: "review",      labelKey: "review.title", badge: "NEW" },
  { hash: "#/fire",        icon: "fire",        labelKey: "nav.fire" },
  { hash: "#/tax",         icon: "tax",         labelKey: "nav.tax" },
  { hash: "#/scenarios",   icon: "scenarios",   labelKey: "nav.scenarios" },
  { hash: "#/rebalance",   icon: "rebalance",   labelKey: "nav.rebalance" },
  { hash: "#/reports",     icon: "reports",     labelKey: "nav.reports" },
];
// Routes that still exist (direct URL works) but are NOT shown in the sidebar.
// Keeping them in ROUTES means /#compare or /#calculator continues to load if
// someone has a bookmark or hits the URL directly.

// Sidebar items rendered just above the language/theme/logout footer.
// Visually separated to give Settings its own "preferences" zone.
const SIDEBAR_BOTTOM_LINKS = [
  { hash: "#/settings",    icon: "settings",    labelKey: "nav.settings" },
];

function destroyCharts() {
  for (const k of Object.keys(state.charts)) {
    try { state.charts[k]?.destroy?.(); } catch (_) {}
    delete state.charts[k];
  }
}

// View-lifecycle cleanup. Views can register MULTIPLE cleanup callbacks
// (the previous single-slot design dropped earlier cleanups when later
// ones were registered — caused "stuck on wrong page" when two clicks
// landed in fast succession). All registered fns run on next navigation.
let _viewCleanups = [];
export function onViewCleanup(fn) { _viewCleanups.push(fn); }
function runViewCleanup() {
  const fns = _viewCleanups;
  _viewCleanups = [];
  for (const fn of fns) {
    try { fn(); } catch (_) {}
  }
}

// Route sequence — incremented on every renderRoute call. Async work
// (module load, view render) checks against this; if a newer route has
// started, abort instead of overwriting the new view's DOM.
let _routeSeq = 0;
// Preload state — once we've eagerly imported every view module, the
// next click skips the dynamic-import wait entirely.
const _preloadedModules = new Map();

async function renderRoute() {
  if (!state.token || !state.user) {
    showAuth();
    return;
  }
  const mySeq = ++_routeSeq;
  const hash = window.location.hash || "#/dashboard";
  const route = ROUTES.find(r => r.hash === hash) || ROUTES[0];
  document.getElementById("page-title").textContent = t(route.titleKey);
  // Analytics: page view per route, with the hash as the path.
  track("page_view", { route: route.hash });
  for (const a of document.querySelectorAll(".sidebar-link, .tab-link")) {
    const isActive = a.dataset.hash === route.hash;
    a.classList.toggle("active", isActive);
    if (isActive) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  runViewCleanup();
  destroyCharts();
  const root = document.getElementById("view-root");
  // Only show the spinner if the module isn't already cached — otherwise
  // the swap is synchronous and showing-then-immediately-replacing a
  // spinner causes a flash. Just leave the existing content briefly.
  if (!_preloadedModules.has(route.hash)) {
    root.innerHTML = `<div style="text-align:center;padding:60px">${spinner(true)}</div>`;
  }
  try {
    const mod = _preloadedModules.get(route.hash) || await route.load();
    // Cache for future navigations (instant on second visit).
    _preloadedModules.set(route.hash, mod);
    // If a newer renderRoute already started, abort so we don't paint
    // the OLD view's content over the new spinner / new view's render.
    if (mySeq !== _routeSeq) return;
    await mod.render(root);
    if (mySeq !== _routeSeq) return;
  } catch (err) {
    if (mySeq !== _routeSeq) return;
    console.error(err);
    root.innerHTML = `<div class="alert-banner error">${err.message || "Failed to load view"}</div>`;
  }
}

// ---------- Auth screen ----------
function showAuth() {
  document.getElementById("app-shell").classList.add("hidden");
  document.getElementById("auth-screen").classList.remove("hidden");
  renderAuthForm("login");
}

function renderAuthForm(mode) {
  const isLogin = mode === "login";
  const c = document.getElementById("auth-container");
  c.innerHTML = `
    <div class="landing">
      <div class="landing-hero">
        <div class="landing-eyebrow">${t("landing.eyebrow")}</div>
        <h1 class="landing-title">${t("landing.title")}</h1>
        <p class="landing-subtitle">${t("landing.subtitle")}</p>
        <ul class="landing-bullets">
          <li>${t("landing.bullet_fire")}</li>
          <li>${t("landing.bullet_tax")}</li>
          <li>${t("landing.bullet_xirr")}</li>
          <li>${t("landing.bullet_immo")}</li>
        </ul>
      </div>
      <div class="auth-card">
        <button id="demo-btn" class="btn btn-demo btn-block" type="button">
          ${t("landing.try_demo")} →
        </button>
        <div class="auth-divider"><span>${t("landing.or")}</span></div>
        <h2>${t(isLogin ? "auth.login_title" : "auth.register_title")}</h2>
        <p class="subtitle">${t(isLogin ? "auth.login_subtitle" : "auth.register_subtitle")}</p>
        <form id="auth-form">
          ${isLogin ? "" : `<div class="field"><label>${t("auth.name")}</label><input name="name" required/></div>`}
          <div class="field"><label>${t("auth.email")}</label><input name="email" type="email" required/></div>
          <div class="field"><label>${t("auth.password")}</label><input name="password" type="password" minlength="6" required/></div>
          <button class="btn btn-primary btn-block" type="submit">${t(isLogin ? "auth.sign_in" : "auth.create_account")}</button>
        </form>
        <div class="switch-link">
          ${isLogin ? t("auth.no_account") : t("auth.have_account")}
          <a id="switch-mode">${isLogin ? t("auth.register_link") : t("auth.login_link")}</a>
        </div>
      </div>
    </div>`;
  document.getElementById("switch-mode").onclick = () => renderAuthForm(isLogin ? "register" : "login");
  document.getElementById("demo-btn").onclick = async () => {
    const btn = document.getElementById("demo-btn");
    btn.disabled = true;
    btn.innerHTML = `${spinner()} ${t("landing.creating_demo")}`;
    try {
      const data = await API.request("/auth/demo", { method: "POST" });
      state.token = data.access_token;
      state.user = data.user;
      localStorage.setItem("token", state.token);
      track("demo_login");
      bootApp().catch(err => toast(err.message || t("common.error_generic"), "error"));
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = `${t("landing.try_demo")} →`;
      toast(err.message || t("common.error_generic"), "error");
    }
  };
  document.getElementById("auth-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const payload = Object.fromEntries(fd.entries());
    try {
      const data = await API.request(isLogin ? "/auth/login" : "/auth/register", { method: "POST", body: payload });
      if (!data || !data.access_token || !data.user || !data.user.name) {
        console.error("Unexpected auth response shape:", data);
        throw new Error("Invalid response from server (missing user data)");
      }
      state.token = data.access_token;
      state.user = data.user;
      localStorage.setItem("token", state.token);
      track(isLogin ? "user_login" : "user_register", { currency: data.user?.currency });
      toast(t(isLogin ? "auth.success_login" : "auth.success_register"), "success");
      // Surface bootApp errors instead of letting them become unhandled rejections.
      bootApp().catch(err => {
        console.error("bootApp failed after auth:", err);
        toast(err.message || t("common.error_generic"), "error");
      });
    } catch (err) {
      console.error("Auth submit failed:", err);
      toast(err.message || t("common.error_generic"), "error");
    }
  };
}

function logout() {
  state.token = null;
  state.user = null;
  state.fxRate = 1.0;
  state.fxFailed = false;
  localStorage.removeItem("token");
  clearSwrCache();
  if (state.sse) { state.sse.close(); state.sse = null; }
  // Reset view-local state that survives across logins via module scope.
  // Lazy-import to avoid loading the dashboard module on the auth screen.
  import(v("/static/views/dashboard.js")).then(m => m.resetActiveTab?.()).catch(() => {});
  showAuth();
}

// ---------- App shell ----------
// Mobile bottom tab bar — 5 most-used routes, Robinhood-style. The full
// sidebar is still reachable on mobile via the hamburger, but the tabbar
// handles the 80% case so a thumb never has to reach for the top-left.
const MOBILE_TABBAR_LINKS = [
  { hash: "#/dashboard",    icon: "dashboard",    labelKey: "nav.dashboard" },
  { hash: "#/investments",  icon: "investments",  labelKey: "nav.investments" },
  { hash: "#/transactions", icon: "transactions", labelKey: "nav.transactions" },
  { hash: "#/review",       icon: "review",       labelKey: "review.title" },
  { hash: "#/fire",         icon: "fire",         labelKey: "nav.fire" },
];

function buildSidebar() {
  const renderLinks = (links) => links.map(l => `
    <a class="sidebar-link" data-hash="${l.hash}" href="${l.hash}">
      <span class="ico">${ICONS[l.icon]}</span><span class="lbl">${t(l.labelKey)}</span>
      ${l.badge ? `<span class="nav-badge">${l.badge}</span>` : ""}
    </a>
  `).join("");
  const nav = document.getElementById("sidebar-nav");
  nav.innerHTML = renderLinks(SIDEBAR_LINKS);
  const navBottom = document.getElementById("sidebar-nav-bottom");
  if (navBottom) navBottom.innerHTML = renderLinks(SIDEBAR_BOTTOM_LINKS);
  // Mobile tabbar
  const tabbar = document.getElementById("mobile-tabbar");
  if (tabbar) {
    tabbar.innerHTML = MOBILE_TABBAR_LINKS.map(l => `
      <a class="tab-link" data-hash="${l.hash}" href="${l.hash}">
        <span class="ico">${ICONS[l.icon]}</span><span class="lbl">${t(l.labelKey)}</span>
      </a>
    `).join("");
  }
  // Update the theme toggle + logout button icons too (they live in the footer
  // and aren't otherwise regenerated, so set them once here on first build).
  const tt = document.getElementById("theme-toggle");
  if (tt) tt.innerHTML = ICONS[state.theme === "dark" ? "sun" : "moon"];
  const lo = document.getElementById("logout-btn");
  if (lo) lo.innerHTML = ICONS.logout;
  const ls = document.getElementById("lang-switch");
  ls.innerHTML = availableLangs().map(l => `<button data-lang="${l}" class="${l === getLang() ? "active" : ""}">${l.toUpperCase()}</button>`).join("");
  ls.querySelectorAll("button").forEach(b => {
    b.onclick = () => { setLang(b.dataset.lang, () => { buildSidebar(); renderRoute(); }); };
  });
}

function setTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
  // Swap the toggle icon to match the new theme (sun in dark mode, moon in light).
  const tt = document.getElementById("theme-toggle");
  if (tt && typeof ICONS !== "undefined") {
    tt.innerHTML = ICONS[theme === "dark" ? "sun" : "moon"];
  }
}

async function bootApp() {
  // If we already have a token but no user, fetch /auth/me to validate.
  if (state.token && !state.user) {
    try {
      const me = await API.request("/auth/me");
      if (!me || !me.name) {
        console.error("/auth/me returned unexpected payload:", me);
        throw new Error("Server returned invalid user data");
      }
      state.user = me;
    } catch (err) {
      console.error("bootApp /auth/me failed:", err);
      logout();
      return;
    }
  }
  // Final safety: if for any reason state.user is still null at this point,
  // route back to auth instead of crashing on `state.user.name` below.
  if (!state.user || !state.user.name) {
    console.warn("bootApp: state.user missing after auth flow, returning to login");
    logout();
    return;
  }
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  document.getElementById("user-chip").textContent = `${state.user.name} · ${state.user.currency || "USD"}`;
  buildSidebar();
  // Fetch the FX rate before rendering so money() shows the right values.
  await loadFxRate();
  // Analytics — fire-and-forget, doesn't block render.
  loadPosthog();
  if (!window.location.hash) window.location.hash = "#/dashboard";
  renderRoute();
  // SSE for live price flashes on the Investments view. Server-side
  // heartbeat is 5s and retry is 30s now, so the previous reconnect
  // loop is gone. Custom events `market:prices` dispatched here are
  // consumed by investments.js to animate cell deltas.
  setupSSE();
  // Cache pre-warm: fire the heavy dashboard endpoints in parallel right
  // after login so the SWR cache is hot by the time the user clicks
  // around. Each call writes to sessionStorage on success — the views
  // then render instantly from cache instead of awaiting the network.
  prewarmCache();
  // Preload every view module in the background after the first render so
  // subsequent navigations skip the dynamic-import wait. Cached in
  // _preloadedModules; renderRoute reads from there before falling back to
  // route.load(). Uses requestIdleCallback so it doesn't fight the initial
  // dashboard render for bandwidth.
  const preload = () => {
    for (const r of ROUTES) {
      if (_preloadedModules.has(r.hash)) continue;
      r.load().then(mod => _preloadedModules.set(r.hash, mod)).catch(() => {});
    }
  };
  if ("requestIdleCallback" in window) {
    requestIdleCallback(preload, { timeout: 2000 });
  } else {
    setTimeout(preload, 500);
  }
}

// Live price feed. Tries WebSocket first (lower overhead, survives proxies
// better than long SSE streams) and falls back to SSE if the upgrade fails
// or the browser doesn't support it.
function setupSSE() {
  if (state.sse) { try { state.sse.close(); } catch (_) {} }
  const handleFrame = (raw) => {
    try {
      const payload = JSON.parse(raw);
      if (payload.type === "prices") {
        window.dispatchEvent(new CustomEvent("market:prices", { detail: payload.data }));
      } else if (payload.type === "indices") {
        window.dispatchEvent(new CustomEvent("market:indices", { detail: payload.data }));
      }
    } catch (_) {}
  };

  // Try WebSocket first
  if ("WebSocket" in window) {
    try {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/market/ws`);
      let opened = false;
      ws.onopen = () => { opened = true; };
      ws.onmessage = (ev) => handleFrame(ev.data);
      ws.onclose = (ev) => {
        // If the WS never opened (server has no /market/ws, or upgrade
        // blocked), fall back to SSE. If it disconnects later, attempt
        // reconnect via WS again — the server will route around the
        // dead connection.
        if (!opened) {
          fallbackToSSE();
        } else if (state.sse === ws) {
          // Schedule reconnect with a small backoff.
          state.sse = null;
          setTimeout(setupSSE, 3000);
        }
      };
      ws.onerror = () => { /* close handler will fall back */ };
      state.sse = ws;
      return;
    } catch (_) { /* fall through */ }
  }
  fallbackToSSE();

  function fallbackToSSE() {
    try {
      const sse = new EventSource("/market/stream");
      sse.onmessage = (ev) => handleFrame(ev.data);
      sse.onerror = () => { /* EventSource auto-reconnects */ };
      state.sse = sse;
    } catch (e) { console.warn("Live feed unavailable:", e); }
  }
}

// Chat removed in this release — the AI value lives in the Monthly Review
// (deterministic insights for everyone + Claude prose when API key set).
// A floating ChatGPT-style box wasn't differentiated enough to keep.

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Bootstrapping ----------
// Global error logging so future bugs surface in the UI instead of being silent.
window.addEventListener("error", (ev) => {
  console.error("[window.error]", ev.message, "at", ev.filename + ":" + ev.lineno);
});
window.addEventListener("unhandledrejection", (ev) => {
  console.error("[unhandled rejection]", ev.reason);
});

function setSidebarOpen(open) {
  const sb = document.querySelector(".sidebar");
  const bd = document.getElementById("sidebar-backdrop");
  const btn = document.getElementById("nav-toggle");
  if (!sb) return;
  sb.classList.toggle("open", open);
  bd?.classList.toggle("open", open);
  btn?.setAttribute("aria-expanded", String(open));
  // Mark body so CSS can hide the chat FAB + lock .main scroll while the
  // mobile sidebar is open (DOM placement means `.sidebar.open ~ .chat-fab`
  // wouldn't match — we use a body class instead).
  document.body.classList.toggle("sidebar-open", open);
  const main = document.querySelector(".main");
  if (main) main.style.overflow = open ? "hidden" : "";
}

// Service Worker — caches the app shell so the app boots offline and
// subsequent visits skip a full network round-trip. Only registers on
// HTTPS (and localhost for dev); not registered on file:// or
// http://example. Errors are silent — SW failure should never break
// the app, just remove the offline ability.
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;
  navigator.serviceWorker.register("/sw.js").catch((err) => {
    console.warn("[sw] registration failed:", err);
  });
}

// "Add to Home Screen" install prompt. Browsers fire `beforeinstallprompt`
// when the PWA criteria are met. We stash the event and show a one-time
// toast inviting the user to install. Suppressed if they dismissed once
// (we set a flag in localStorage).
let _deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  if (localStorage.getItem("install_dismissed")) return;
  _deferredInstallPrompt = e;
  // Only nudge once per session, after the user has clicked around a bit.
  setTimeout(() => {
    if (!_deferredInstallPrompt) return;
    const host = document.getElementById("toast-host");
    if (!host) return;
    const el = document.createElement("div");
    el.className = "toast install-toast";
    el.innerHTML = `
      <div style="display:flex;gap:12px;align-items:center">
        <div style="flex:1">
          <strong style="display:block;margin-bottom:2px">${escapeHtml(t("app.install_title") || "Install InvestApp")}</strong>
          <span style="font-size:12px;color:var(--text-muted)">${escapeHtml(t("app.install_sub") || "Add to your home screen for one-tap access")}</span>
        </div>
        <button class="btn btn-primary" id="install-yes" style="padding:6px 12px;font-size:13px">${escapeHtml(t("app.install_yes") || "Install")}</button>
        <button class="icon-btn" id="install-no" aria-label="Dismiss">✕</button>
      </div>`;
    host.appendChild(el);
    el.querySelector("#install-yes").onclick = async () => {
      const e2 = _deferredInstallPrompt;
      _deferredInstallPrompt = null;
      el.remove();
      try { await e2.prompt(); } catch (_) {}
    };
    el.querySelector("#install-no").onclick = () => {
      localStorage.setItem("install_dismissed", "1");
      _deferredInstallPrompt = null;
      el.remove();
    };
  }, 30000); // 30s grace — only prompt after the user has stuck around
});

document.addEventListener("DOMContentLoaded", () => {
  setTheme(state.theme);
  registerServiceWorker();
  // Pull any SWR entries persisted in IndexedDB into memory so the first
  // post-restart navigation skips the network on a still-fresh entry.
  // Doesn't block the boot — fires in parallel with the rest.
  hydrateSwrCache().catch(() => {});
  document.getElementById("theme-toggle").onclick = () => setTheme(state.theme === "dark" ? "light" : "dark");
  document.getElementById("logout-btn").onclick = logout;
  document.getElementById("mobile-logout")?.addEventListener("click", logout);
  // Hamburger nav on mobile
  document.getElementById("nav-toggle")?.addEventListener("click", () => {
    const sb = document.querySelector(".sidebar");
    setSidebarOpen(!sb?.classList.contains("open"));
  });
  document.getElementById("sidebar-backdrop")?.addEventListener("click", () => setSidebarOpen(false));
  // Auto-close sidebar when the user picks a link OR clicks any control
  // (theme toggle, logout) on mobile.
  const closeOnSidebarInteraction = (ev) => {
    if (ev.target.closest("a") || ev.target.closest("button")) setSidebarOpen(false);
  };
  document.getElementById("sidebar-nav")?.addEventListener("click", closeOnSidebarInteraction);
  document.getElementById("sidebar-nav-bottom")?.addEventListener("click", closeOnSidebarInteraction);
  document.querySelector(".sidebar-footer")?.addEventListener("click", closeOnSidebarInteraction);
  window.addEventListener("hashchange", () => {
    setSidebarOpen(false);
    renderRoute();
  });

  if (state.token) {
    bootApp().catch(err => { console.error(err); logout(); });
  } else {
    showAuth();
  }
});
