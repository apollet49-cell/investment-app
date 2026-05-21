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
import { API, state } from "/static/app.js";

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
