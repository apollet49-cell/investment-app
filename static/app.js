// Single-page app entry point. Hash-based router, module-level state,
// JSON API wrapper that injects the JWT and handles 401 once. View
// modules are lazy-loaded.
//
// This file owns the SPA shell: routing, boot, sidebar, SSE/WebSocket,
// install prompt. The reusable building blocks (SWR cache, UI helpers,
// FX, analytics, auth UI) live in ./app/*.js and are re-exported here so
// the 22 view modules can keep importing everything from "/static/app.js".
import { t, getLang, setLang, availableLangs } from "/static/i18n.js";

// ---------- State ----------
export const state = {
  user: null,
  token: localStorage.getItem("token") || null,
  theme: localStorage.getItem("theme") || "dark",
  charts: {},               // { name: Chart.js instance, destroyed on view change }
  sse: null,                // EventSource / WebSocket
  lastPrices: new Map(),    // for flash animations
  fxRate: 1.0,              // USD → user.currency multiplier (1.0 when user.currency == "USD")
  fxFetchedAt: null,
};

// ---------- HTTP wrapper ----------
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

// ---------- Sub-module re-exports ----------
// Imports must be hoisted, so the bindings in cache/ui/fx/analytics/auth_ui
// see `state` and `API` (defined above) by the time their bodies execute.
export {
  hydrateSwrCache,
  cachedGet,
  clearSwrCache,
  prewarmCache,
  invalidateCache,
  seedCache,
} from "/static/app/cache.js";
export { toast, confirmModal, animateNumber, spinner, skeleton } from "/static/app/ui.js";
export { loadFxRate } from "/static/app/fx.js";
export { track } from "/static/app/analytics.js";
import { clearSwrCache, prewarmCache } from "/static/app/cache.js";
import { toast } from "/static/app/ui.js";
import { loadFxRate } from "/static/app/fx.js";
import { track, loadPosthog } from "/static/app/analytics.js";
import { showAuth } from "/static/app/auth_ui.js";

// ---------- Lazy script loader ----------
// Memoised Promise so concurrent callers get the same load. Used to
// defer Chart.js and lightweight-charts (combined ~300KB unzipped) from
// the index.html <script> tags — those pulled the libs even on routes
// that don't draw any charts. Now each chart-using view does:
//   await loadChartJs();
//   state.charts.foo = new window.Chart(ctx, { ... });
const _scriptCache = new Map();
export function loadScript(src, integrity) {
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
    if (integrity) {
      s.integrity = integrity;
      s.crossOrigin = "anonymous";
    }
    s.onload = () => { s.dataset.loaded = "1"; resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
  _scriptCache.set(src, p);
  return p;
}
export const loadChartJs = () =>
  window.Chart ? Promise.resolve() : loadScript(
    "https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js",
    "sha384-NrKB+u6Ts6AtkIhwPixiKTzgSKNblyhlk0Sohlgar9UHUBzai/sgnNNWWd291xqt",
  );
export const loadLightweightCharts = () =>
  window.LightweightCharts ? Promise.resolve() : loadScript(
    "https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js",
    "sha384-JZigAjwiaZtkUbA44CWkPaT3iBb/mU5pO6QOANp+OqHd4q+1+7MG1kzp2OOP9ZfP",
  );

// ---------- Authenticated download ----------
// Browsers don't add the Authorization header on a plain <a href> click,
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

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Routing ----------
// Bump VIEW_VERSION whenever any /static/views/*.js changes so users on a
// stale tab pick up the new module on next route change. Match the value
// to ?v=N on app.js / style.css in index.html.
const VIEW_VERSION = "96";
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
  { hash: "#/compare", titleKey: "compare.title", load: () => import(v("/static/views/compare.js")) },
  { hash: "#/risk", titleKey: "risk.title", load: () => import(v("/static/views/risk.js")) },
  { hash: "#/performance", titleKey: "performance.title", load: () => import(v("/static/views/performance.js")) },
];

// Inline SVG icons (Feather/Lucide style, 1.5px stroke, currentColor so they
// follow the link's text color). Single source of truth — referenced by name
// in SIDEBAR_LINKS below.
const ICONS = {
  dashboard:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>`,
  investments: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><path d="M3 13h18"/></svg>`,
  calculator:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8"/><path d="M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/></svg>`,
  scenarios:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/></svg>`,
  compare:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18 L9 8 L14 14 L21 4"/><path d="M3 19 H21"/><circle cx="9" cy="8" r="1.4" fill="currentColor"/><circle cx="14" cy="14" r="1.4" fill="currentColor"/></svg>`,
  risk:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12 L7 12 L9 6 L13 18 L15 10 L17 14 L21 14"/></svg>`,
  performance: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17 C 7 13, 10 14, 13 9, 17 4, 21 6"/><path d="M3 19 C 8 17, 12 16, 16 14, 18 12, 21 13" stroke-dasharray="2,2"/></svg>`,
  reports:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>`,
  tax:         `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><circle cx="7" cy="7" r="2"/><circle cx="17" cy="17" r="2"/><path d="M3 3 H21 V21 H3 Z" stroke-dasharray="2,3"/></svg>`,
  fire:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14a4 4 0 0 0 8 0c0-2-1-3.5-3-5 0 2-1 3-2 3.5 0-1.5-1-2.5-1-2.5-1 1-2 2.5-2 4z"/><path d="M12 2c0 3-2 4-2 6"/></svg>`,
  transactions:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 3 21 7 17 11"/><line x1="21" y1="7" x2="9" y2="7"/><polyline points="7 21 3 17 7 13"/><line x1="3" y1="17" x2="15" y2="17"/></svg>`,
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
  { hash: "#/compare",     icon: "compare",     labelKey: "nav.compare" },
  { hash: "#/risk",        icon: "risk",        labelKey: "nav.risk" },
  { hash: "#/performance", icon: "performance", labelKey: "nav.performance", badge: "NEW" },
  { hash: "#/rebalance",   icon: "rebalance",   labelKey: "nav.rebalance" },
  { hash: "#/reports",     icon: "reports",     labelKey: "nav.reports" },
];
const SIDEBAR_BOTTOM_LINKS = [
  { hash: "#/settings",    icon: "settings",    labelKey: "nav.settings" },
];
const MOBILE_TABBAR_LINKS = [
  { hash: "#/dashboard",    icon: "dashboard",    labelKey: "nav.dashboard" },
  { hash: "#/investments",  icon: "investments",  labelKey: "nav.investments" },
  { hash: "#/transactions", icon: "transactions", labelKey: "nav.transactions" },
  { hash: "#/review",       icon: "review",       labelKey: "review.title" },
  { hash: "#/fire",         icon: "fire",         labelKey: "nav.fire" },
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
  const hash = window.location.hash || "#/dashboard";
  // Landing-only anchors (#lv-honest etc.) can fire hashchange even when
  // the landing is hidden. Don't bounce the authenticated user to
  // dashboard — silently ignore. Same for empty / "#" hashes.
  if (hash.startsWith("#lv-") || hash === "" || hash === "#") return;
  // Unknown routes (typos, removed features like #/markets) → silently
  // rewrite to dashboard via hash change rather than rendering dashboard
  // under the wrong URL.
  const route = ROUTES.find(r => r.hash === hash);
  if (!route) {
    window.location.hash = "#/dashboard";
    return;
  }
  const mySeq = ++_routeSeq;
  const routeTitle = t(route.titleKey);
  document.getElementById("page-title").textContent = routeTitle;
  document.title = `${routeTitle} · InvestApp`;
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
  // Two DOM-attached tokens to defeat the rollback bug:
  //   - dataset.route    : current hash (e.g. "#/fire")
  //   - dataset.renderId : unique id per renderRoute call
  // Views capture BOTH at render start. A stale async resolving after a
  // navigation sees a different renderId (even if the route happens to
  // match — e.g. user navigates dashboard → fire → dashboard within the
  // same fetch window) and bails before painting.
  root.dataset.route = route.hash;
  root.dataset.renderId = String(mySeq);
  // Only show the spinner if the module isn't already cached — otherwise
  // the swap is synchronous and showing-then-immediately-replacing a
  // spinner causes a flash.
  if (!_preloadedModules.has(route.hash)) {
    const { spinner } = await import("/static/app/ui.js");
    root.innerHTML = `<div style="text-align:center;padding:60px">${spinner(true)}</div>`;
  }
  try {
    const mod = _preloadedModules.get(route.hash) || await route.load();
    _preloadedModules.set(route.hash, mod);
    if (mySeq !== _routeSeq) return;
    await mod.render(root);
    if (mySeq !== _routeSeq) return;
  } catch (err) {
    if (mySeq !== _routeSeq) return;
    console.error(err);
    root.innerHTML = `<div class="alert-banner error">${err.message || "Failed to load view"}</div>`;
  }
}

// ---------- Logout ----------
export function logout() {
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

// ---------- Sidebar ----------
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
  const tabbar = document.getElementById("mobile-tabbar");
  if (tabbar) {
    tabbar.innerHTML = MOBILE_TABBAR_LINKS.map(l => `
      <a class="tab-link" data-hash="${l.hash}" href="${l.hash}">
        <span class="ico">${ICONS[l.icon]}</span><span class="lbl">${t(l.labelKey)}</span>
      </a>
    `).join("");
  }
  // Theme toggle + logout icons live in the footer and aren't otherwise
  // regenerated, so set them once here on first build.
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
  const tt = document.getElementById("theme-toggle");
  if (tt && typeof ICONS !== "undefined") {
    tt.innerHTML = ICONS[theme === "dark" ? "sun" : "moon"];
  }
}

// ---------- Boot ----------
export async function bootApp() {
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
  if (!state.user || !state.user.name) {
    console.warn("bootApp: state.user missing after auth flow, returning to login");
    logout();
    return;
  }
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  document.getElementById("user-chip").textContent = `${state.user.name} · ${state.user.currency || "USD"}`;
  buildSidebar();
  await loadFxRate();
  loadPosthog();
  // Normalise the hash to a valid app route before the first render.
  // After demo/login the hash might be #lv-pricing (CTA on the landing)
  // or empty, or an old removed route. replaceState avoids firing a
  // hashchange that would double-render the view.
  const _hash = window.location.hash;
  const _isValid = _hash && ROUTES.some(r => r.hash === _hash);
  if (!_isValid) {
    history.replaceState(null, "", "/#/dashboard");
  }
  renderRoute();
  setupSSE();
  prewarmCache();
  // Mount the floating "ask InvestAI" chat panel into the app shell. The
  // module sets up a single FAB + panel pair the first time; subsequent
  // logouts/logins on the same page no-op safely. Loaded lazily so the
  // landing doesn't carry its weight.
  import(v("/static/views/chat-panel.js")).then(m => m.mountChatPanel?.()).catch(() => {});
  // Preload every view module in the background after the first render so
  // subsequent navigations skip the dynamic-import wait.
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

// ---------- Live price feed ----------
// Tries WebSocket first (lower overhead, survives proxies better than
// long SSE streams) and falls back to SSE if the upgrade fails or the
// browser doesn't support it.
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

  if ("WebSocket" in window) {
    try {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/market/ws`);
      let opened = false;
      ws.onopen = () => { opened = true; };
      ws.onmessage = (ev) => handleFrame(ev.data);
      ws.onclose = (ev) => {
        if (!opened) {
          fallbackToSSE();
        } else if (state.sse === ws) {
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
  document.body.classList.toggle("sidebar-open", open);
  const main = document.querySelector(".main");
  if (main) main.style.overflow = open ? "hidden" : "";
}

// Service Worker — caches the app shell so the app boots offline and
// subsequent visits skip a full network round-trip. Only registers on
// HTTPS (and localhost for dev). Errors are silent.
//
// `controllerchange` reload: when a new SW activates (we bumped
// CACHE_VERSION), the new SW takes control of this page mid-session. The
// in-memory JS is still the OLD version though — that's the root cause
// of "fixes shipped but bug persists" reports, because users keep running
// stale code while the SW serves a fresh shell on next reload only. A
// one-shot reload on controllerchange forces the page to pick up the new
// JS immediately. Guarded so the very first SW install (no previous
// controller) doesn't trigger a reload loop.
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return; // first install — no stale code to flush
    console.log("[sw] new SW activated, reloading to pick up fresh JS");
    window.location.reload();
  });
  navigator.serviceWorker.register("/sw.js").catch((err) => {
    console.warn("[sw] registration failed:", err);
  });
}

// "Add to Home Screen" install prompt. Browsers fire beforeinstallprompt
// when the PWA criteria are met. We stash the event and show a one-time
// toast inviting the user to install. Suppressed if they dismissed once.
let _deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  if (localStorage.getItem("install_dismissed")) return;
  _deferredInstallPrompt = e;
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
  }, 30000); // 30s grace
});

document.addEventListener("DOMContentLoaded", () => {
  setTheme(state.theme);
  registerServiceWorker();
  // Pull any SWR entries persisted in IndexedDB into memory so the first
  // post-restart navigation skips the network on a still-fresh entry.
  import("/static/app/cache.js").then(m => m.hydrateSwrCache().catch(() => {}));
  document.getElementById("theme-toggle").onclick = () => setTheme(state.theme === "dark" ? "light" : "dark");
  document.getElementById("logout-btn").onclick = logout;
  document.getElementById("mobile-logout")?.addEventListener("click", logout);
  document.getElementById("nav-toggle")?.addEventListener("click", () => {
    const sb = document.querySelector(".sidebar");
    setSidebarOpen(!sb?.classList.contains("open"));
  });
  document.getElementById("sidebar-backdrop")?.addEventListener("click", () => setSidebarOpen(false));
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
