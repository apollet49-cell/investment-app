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
  try {
    const data = await API.request(`/market/forex/USD/${cur}`);
    if (data?.rate && isFinite(data.rate) && data.rate > 0) {
      state.fxRate = data.rate;
      state.fxFetchedAt = Date.now();
      state.fxFailed = false;
      return data.rate;
    }
  } catch (e) {
    console.warn(`FX rate USD→${cur} failed, falling back to 1.0:`, e.message);
  }
  state.fxRate = 1.0;
  state.fxFailed = true;
  return 1.0;
}

// ---------- Authenticated download ----------
// Browsers don't add the Authorization header on a plain `<a href>` click,
// so any export endpoint behind get_current_user 401s on a vanilla link.
// This fetches with the bearer token, builds a blob, and triggers a click
// on a transient anchor so the browser presents the standard save dialog.
export async function downloadAuth(path) {
  try {
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
const VIEW_VERSION = "47";
const v = (path) => `${path}?v=${VIEW_VERSION}`;
const ROUTES = [
  { hash: "#/dashboard", titleKey: "dashboard.title", load: () => import(v("/static/views/dashboard.js")) },
  { hash: "#/markets", titleKey: "markets.title", load: () => import(v("/static/views/markets.js")) },
  { hash: "#/compare", titleKey: "compare.title", load: () => import(v("/static/views/compare.js")) },
  { hash: "#/watchlist", titleKey: "watchlist.title", load: () => import(v("/static/views/watchlist.js")) },
  { hash: "#/investments", titleKey: "investments.title", load: () => import(v("/static/views/investments.js")) },
  { hash: "#/calculator", titleKey: "calculator.title", load: () => import(v("/static/views/calculator.js")) },
  { hash: "#/scenarios", titleKey: "scenarios.title", load: () => import(v("/static/views/scenarios.js")) },
  { hash: "#/transactions", titleKey: "transactions.title", load: () => import(v("/static/views/transactions.js")) },
  { hash: "#/plans", titleKey: "plans.title", load: () => import(v("/static/views/plans.js")) },
  { hash: "#/rebalance", titleKey: "rebalance.title", load: () => import(v("/static/views/rebalance.js")) },
  { hash: "#/chat", titleKey: "chat.title", load: () => import(v("/static/views/chat.js")) },
  { hash: "#/reports", titleKey: "reports.title", load: () => import(v("/static/views/reports.js")) },
  { hash: "#/tax", titleKey: "tax.title", load: () => import(v("/static/views/tax.js")) },
  { hash: "#/fire", titleKey: "fire.title", load: () => import(v("/static/views/fire.js")) },
  { hash: "#/settings", titleKey: "settings.title", load: () => import(v("/static/views/settings.js")) },
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
};

// FIRE/FR-focused navigation. Patrimoine pages first, then planning, then
// auxiliary tools. Compare and Calculator removed from the sidebar — still
// reachable by direct URL (#/compare, #/calculator) for power users, but
// not surfaced to keep the menu coherent. Markets stays as the asset
// browser (more useful than Compare for the FIRE-tracker positioning).
const SIDEBAR_LINKS = [
  { hash: "#/dashboard",   icon: "dashboard",   labelKey: "nav.dashboard" },
  { hash: "#/investments", icon: "investments", labelKey: "nav.investments" },
  { hash: "#/transactions",icon: "transactions",labelKey: "nav.transactions" },
  { hash: "#/markets",     icon: "markets",     labelKey: "nav.markets" },
  { hash: "#/watchlist",   icon: "watchlist",   labelKey: "nav.watchlist" },
  { hash: "#/fire",        icon: "fire",        labelKey: "nav.fire" },
  { hash: "#/tax",         icon: "tax",         labelKey: "nav.tax" },
  { hash: "#/scenarios",   icon: "scenarios",   labelKey: "nav.scenarios" },
  { hash: "#/plans",       icon: "plans",       labelKey: "nav.plans" },
  { hash: "#/rebalance",   icon: "rebalance",   labelKey: "nav.rebalance" },
  { hash: "#/chat",        icon: "chat",        labelKey: "nav.chat" },
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

// View-lifecycle cleanup. Views can register a cleanup callback (e.g. to clear
// auto-refresh intervals) that the router runs before swapping to a new view.
let _viewCleanup = null;
export function onViewCleanup(fn) { _viewCleanup = fn; }
function runViewCleanup() {
  if (_viewCleanup) {
    try { _viewCleanup(); } catch (_) {}
    _viewCleanup = null;
  }
}

async function renderRoute() {
  if (!state.token || !state.user) {
    showAuth();
    return;
  }
  const hash = window.location.hash || "#/dashboard";
  const route = ROUTES.find(r => r.hash === hash) || ROUTES[0];
  document.getElementById("page-title").textContent = t(route.titleKey);
  for (const a of document.querySelectorAll(".sidebar-link")) {
    a.classList.toggle("active", a.dataset.hash === route.hash);
  }
  runViewCleanup();
  destroyCharts();
  const root = document.getElementById("view-root");
  root.innerHTML = `<div style="text-align:center;padding:60px">${spinner(true)}</div>`;
  try {
    const mod = await route.load();
    await mod.render(root);
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="alert-banner error">${err.message || "Failed to load view"}</div>`;
  }
}

// ---------- Auth screen ----------
function showAuth() {
  document.getElementById("app-shell").classList.add("hidden");
  document.getElementById("chat-fab").classList.add("hidden");
  document.getElementById("chat-panel").classList.add("hidden");
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
        <div class="landing-demo-hint">${t("landing.demo_hint")}</div>
      </div>
    </div>`;
  document.getElementById("switch-mode").onclick = () => renderAuthForm(isLogin ? "register" : "login");
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
  if (state.sse) { state.sse.close(); state.sse = null; }
  // Reset view-local state that survives across logins via module scope.
  // Lazy-import to avoid loading the dashboard module on the auth screen.
  import(v("/static/views/dashboard.js")).then(m => m.resetActiveTab?.()).catch(() => {});
  showAuth();
}

// ---------- App shell ----------
function buildSidebar() {
  const renderLinks = (links) => links.map(l => `
    <a class="sidebar-link" data-hash="${l.hash}" href="${l.hash}">
      <span class="ico">${ICONS[l.icon]}</span><span class="lbl">${t(l.labelKey)}</span>
    </a>
  `).join("");
  const nav = document.getElementById("sidebar-nav");
  nav.innerHTML = renderLinks(SIDEBAR_LINKS);
  const navBottom = document.getElementById("sidebar-nav-bottom");
  if (navBottom) navBottom.innerHTML = renderLinks(SIDEBAR_BOTTOM_LINKS);
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
  document.getElementById("chat-fab").classList.remove("hidden");
  document.getElementById("user-chip").textContent = `${state.user.name} · ${state.user.currency || "USD"}`;
  buildSidebar();
  // Fetch the FX rate before rendering so money() shows the right values.
  await loadFxRate();
  if (!window.location.hash) window.location.hash = "#/dashboard";
  renderRoute();
  setupSSE();
}

function setupSSE() {
  if (state.sse) { state.sse.close(); }
  // EventSource doesn't support custom headers, so SSE is open for any local
  // connection here. Acceptable for v1 single-user dev; upgrade to a token query
  // param + middleware if exposing publicly.
  try {
    state.sse = new EventSource("/market/stream");
    state.sse.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        if (payload.type === "prices") {
          window.dispatchEvent(new CustomEvent("market:prices", { detail: payload.data }));
        } else if (payload.type === "indices") {
          window.dispatchEvent(new CustomEvent("market:indices", { detail: payload.data }));
        }
      } catch (_) {}
    };
    state.sse.onerror = () => { /* EventSource auto-reconnects */ };
  } catch (e) {
    console.warn("SSE not available:", e);
  }
}

// ---------- Floating chat panel ----------
async function toggleChatPanel(open) {
  const panel = document.getElementById("chat-panel");
  const isOpen = !panel.classList.contains("hidden");
  const next = open === undefined ? !isOpen : open;
  panel.classList.toggle("hidden", !next);
  if (next) {
    document.getElementById("chat-panel-title").textContent = t("chat.title");
    document.getElementById("chat-panel-input").placeholder = t("chat.placeholder");
    await loadChatPanelHistory();
  }
}

async function loadChatPanelHistory() {
  const messages = document.getElementById("chat-panel-messages");
  messages.innerHTML = `<div style="text-align:center">${spinner()}</div>`;
  try {
    const history = await API.request("/chat/history");
    if (!history.length) {
      messages.innerHTML = `<div class="empty-state"><p>${t("chat.empty")}</p></div>`;
      return;
    }
    messages.innerHTML = history.map(msgHtml).join("");
    messages.scrollTop = messages.scrollHeight;
  } catch (err) {
    messages.innerHTML = `<div class="msg error">${err.message}</div>`;
  }
}

function msgHtml(m) {
  const cls = m.role === "user" ? "user" : (m.role === "assistant" ? "assistant" : "error");
  return `<div class="msg ${cls}">${escapeHtml(m.content)}</div>`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export async function sendChatMessage(text, messagesEl, onDone) {
  // Append user bubble immediately
  messagesEl.insertAdjacentHTML("beforeend", msgHtml({ role: "user", content: text }));
  const assistantBubble = document.createElement("div");
  assistantBubble.className = "msg assistant";
  assistantBubble.innerHTML = `<div class="typing"><span></span><span></span><span></span></div>`;
  messagesEl.appendChild(assistantBubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  let accumulated = "";
  try {
    // Streaming SSE response — can't use API.request (which parses JSON).
    // We mimic API.request's 401-→-logout behaviour manually so an expired
    // token mid-chat redirects to login instead of just showing "Error 401".
    const res = await fetch("/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${state.token}` },
      body: JSON.stringify({ message: text }),
    });
    if (res.status === 401) {
      logout();
      assistantBubble.remove();
      return;
    }
    if (!res.ok || !res.body) {
      assistantBubble.classList.remove("assistant");
      assistantBubble.classList.add("error");
      assistantBubble.textContent = `Error ${res.status}: ${res.statusText}`;
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const ev of events) {
        const line = ev.split("\n").find(l => l.startsWith("data:"));
        if (!line) continue;
        try {
          const payload = JSON.parse(line.slice(5).trim());
          if (payload.delta) {
            accumulated += payload.delta;
            assistantBubble.textContent = accumulated;
            messagesEl.scrollTop = messagesEl.scrollHeight;
          } else if (payload.error) {
            assistantBubble.classList.remove("assistant");
            assistantBubble.classList.add("error");
            assistantBubble.textContent = payload.error;
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    assistantBubble.classList.remove("assistant");
    assistantBubble.classList.add("error");
    assistantBubble.textContent = err.message || "Stream failed";
  }
  if (onDone) onDone(accumulated);
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
  // Lock body scroll while the sidebar is open on mobile
  document.body.style.overflow = open ? "hidden" : "";
}

document.addEventListener("DOMContentLoaded", () => {
  setTheme(state.theme);
  document.getElementById("theme-toggle").onclick = () => setTheme(state.theme === "dark" ? "light" : "dark");
  document.getElementById("logout-btn").onclick = logout;
  document.getElementById("mobile-logout")?.addEventListener("click", logout);
  // Hamburger nav on mobile
  document.getElementById("nav-toggle")?.addEventListener("click", () => {
    const sb = document.querySelector(".sidebar");
    setSidebarOpen(!sb?.classList.contains("open"));
  });
  document.getElementById("sidebar-backdrop")?.addEventListener("click", () => setSidebarOpen(false));
  // Auto-close sidebar when the user picks a link on mobile
  document.getElementById("sidebar-nav")?.addEventListener("click", (ev) => {
    if (ev.target.closest("a")) setSidebarOpen(false);
  });
  document.getElementById("sidebar-nav-bottom")?.addEventListener("click", (ev) => {
    if (ev.target.closest("a")) setSidebarOpen(false);
  });
  document.getElementById("chat-fab").onclick = () => toggleChatPanel(true);
  document.getElementById("chat-close").onclick = () => toggleChatPanel(false);
  document.getElementById("chat-clear").onclick = async () => {
    try {
      await API.request("/chat/history", { method: "DELETE" });
      await loadChatPanelHistory();
    } catch (e) { toast(e.message, "error"); }
  };
  document.getElementById("chat-panel-form").onsubmit = (ev) => {
    ev.preventDefault();
    const ta = document.getElementById("chat-panel-input");
    const text = ta.value.trim();
    if (!text) return;
    ta.value = "";
    sendChatMessage(text, document.getElementById("chat-panel-messages"));
  };
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
