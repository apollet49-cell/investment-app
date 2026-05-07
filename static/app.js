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

// ---------- Formatting ----------
export function money(value, currency) {
  const ccy = currency || state.user?.currency || "USD";
  try {
    return new Intl.NumberFormat(getLang() === "zh" ? "zh-CN" : getLang(), { style: "currency", currency: ccy, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${ccy} ${Number(value).toFixed(2)}`;
  }
}
export function pct(value, signed = true) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const sign = signed ? (value > 0 ? "+" : value < 0 ? "" : "") : "";
  return `${sign}${Number(value).toFixed(2)}%`;
}

// ---------- Routing ----------
const ROUTES = [
  { hash: "#/dashboard", titleKey: "dashboard.title", load: () => import("/static/views/dashboard.js") },
  { hash: "#/markets", titleKey: "markets.title", load: () => import("/static/views/markets.js") },
  { hash: "#/watchlist", titleKey: "watchlist.title", load: () => import("/static/views/watchlist.js") },
  { hash: "#/investments", titleKey: "investments.title", load: () => import("/static/views/investments.js") },
  { hash: "#/calculator", titleKey: "calculator.title", load: () => import("/static/views/calculator.js") },
  { hash: "#/scenarios", titleKey: "scenarios.title", load: () => import("/static/views/scenarios.js") },
  { hash: "#/chat", titleKey: "chat.title", load: () => import("/static/views/chat.js") },
  { hash: "#/reports", titleKey: "reports.title", load: () => import("/static/views/reports.js") },
  { hash: "#/settings", titleKey: "settings.title", load: () => import("/static/views/settings.js") },
];

const SIDEBAR_LINKS = [
  { hash: "#/dashboard", icon: "📊", labelKey: "nav.dashboard" },
  { hash: "#/markets", icon: "🌐", labelKey: "nav.markets" },
  { hash: "#/watchlist", icon: "⭐", labelKey: "nav.watchlist" },
  { hash: "#/investments", icon: "💼", labelKey: "nav.investments" },
  { hash: "#/calculator", icon: "🧮", labelKey: "nav.calculator" },
  { hash: "#/scenarios", icon: "📈", labelKey: "nav.scenarios" },
  { hash: "#/chat", icon: "💬", labelKey: "nav.chat" },
  { hash: "#/reports", icon: "📑", labelKey: "nav.reports" },
  { hash: "#/settings", icon: "⚙️", labelKey: "nav.settings" },
];

function destroyCharts() {
  for (const k of Object.keys(state.charts)) {
    try { state.charts[k]?.destroy?.(); } catch (_) {}
    delete state.charts[k];
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
    </div>`;
  document.getElementById("switch-mode").onclick = () => renderAuthForm(isLogin ? "register" : "login");
  document.getElementById("auth-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const payload = Object.fromEntries(fd.entries());
    try {
      const data = await API.request(isLogin ? "/auth/login" : "/auth/register", { method: "POST", body: payload });
      state.token = data.access_token;
      state.user = data.user;
      localStorage.setItem("token", state.token);
      toast(t(isLogin ? "auth.success_login" : "auth.success_register"), "success");
      bootApp();
    } catch (err) {
      toast(err.message || t("common.error_generic"), "error");
    }
  };
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem("token");
  if (state.sse) { state.sse.close(); state.sse = null; }
  showAuth();
}

// ---------- App shell ----------
function buildSidebar() {
  const nav = document.getElementById("sidebar-nav");
  nav.innerHTML = SIDEBAR_LINKS.map(l => `
    <a class="sidebar-link" data-hash="${l.hash}" href="${l.hash}">
      <span class="ico">${l.icon}</span><span>${t(l.labelKey)}</span>
    </a>
  `).join("");
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
}

async function bootApp() {
  // If we already have a token but no user, fetch /auth/me to validate.
  if (state.token && !state.user) {
    try {
      state.user = await API.request("/auth/me");
    } catch {
      logout();
      return;
    }
  }
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  document.getElementById("chat-fab").classList.remove("hidden");
  document.getElementById("user-chip").textContent = `${state.user.name} · ${state.user.currency}`;
  buildSidebar();
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
    const res = await fetch("/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${state.token}` },
      body: JSON.stringify({ message: text }),
    });
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
document.addEventListener("DOMContentLoaded", () => {
  setTheme(state.theme);
  document.getElementById("theme-toggle").onclick = () => setTheme(state.theme === "dark" ? "light" : "dark");
  document.getElementById("logout-btn").onclick = logout;
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
  window.addEventListener("hashchange", renderRoute);

  if (state.token) {
    bootApp().catch(err => { console.error(err); logout(); });
  } else {
    showAuth();
  }
});
