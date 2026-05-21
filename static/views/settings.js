import { API, state, toast, escapeHtml, loadFxRate, onViewCleanup } from "/static/app.js";
import { t } from "/static/i18n.js";

const CURRENCIES = ["USD", "EUR", "GBP", "CHF"];

export async function render(root) {
  let cancelled = false;
  onViewCleanup(() => { cancelled = true; });
  const myRenderId = root.dataset.renderId;
  const stillOwnsRoot = () => !cancelled && root.dataset.renderId === myRenderId;

  // Defensive guard: state.user should always be set when this view renders,
  // but if for any reason it isn't (race condition, expired session, etc.),
  // fall back to /auth/me before reading fields.
  if (!state.user || !state.user.name) {
    try {
      state.user = await API.request("/auth/me");
    } catch (err) {
      if (!stillOwnsRoot()) return;
      root.innerHTML = `<div class="alert-banner error">${err.message || "Session expired — please log in again."}</div>`;
      return;
    }
    if (!stillOwnsRoot()) return;
  }
  const user = state.user;

  let alerts = [];
  try { alerts = await API.request("/alerts/"); } catch (_) {}
  if (!stillOwnsRoot()) return;
  const roiAlert = alerts.find(a => a.type === "roi_below" && a.scope === "portfolio");
  const ddAlert = alerts.find(a => a.type === "drawdown_above" && a.scope === "portfolio");

  root.innerHTML = `
    <div class="card">
      <h3>${t("settings.profile")}</h3>
      <form id="settings-form">
        <div class="row">
          <div class="col field"><label>${t("settings.name")}</label><input name="name" value="${escapeHtml(user.name || "")}"/></div>
          <div class="col field"><label>${t("settings.email")}</label><input name="email" type="email" value="${escapeHtml(user.email || "")}"/></div>
        </div>
        <div class="row">
          <div class="col field"><label>${t("settings.currency")}</label>
            <select name="currency">${CURRENCIES.map(c => `<option value="${c}" ${c === user.currency ? "selected" : ""}>${c}</option>`).join("")}</select>
          </div>
          <div class="col field"><label>${t("settings.new_password")}</label><input name="password" type="password" minlength="6"/></div>
        </div>
        <h3 style="margin-top:24px">${t("settings.api_keys")}</h3>
        <div class="field">
          <label>${t("settings.anthropic_key")}</label>
          <input name="anthropic_api_key" type="password" placeholder="${user.has_anthropic_key ? t("settings.has_key") : t("settings.no_key")}"/>
          <p style="color:var(--text-muted);font-size:12px;margin:6px 0 0">${t("settings.anthropic_key_help")}</p>
        </div>
        <button class="btn btn-primary" type="submit">${t("settings.save")}</button>
      </form>
    </div>
    <div style="height:16px"></div>
    <div class="card">
      <h3>${t("settings.alert_thresholds")}</h3>
      <form id="alerts-form">
        <div class="row">
          <div class="col field"><label>${t("settings.roi_below")}</label>
            <input id="roi-thresh" type="number" step="0.5" value="${roiAlert ? roiAlert.threshold : 5}" data-existing="${roiAlert?.id || ""}"/></div>
          <div class="col field"><label>${t("settings.drawdown_above")}</label>
            <input id="dd-thresh" type="number" step="0.5" value="${ddAlert ? ddAlert.threshold : 10}" data-existing="${ddAlert?.id || ""}"/></div>
        </div>
        <button class="btn btn-primary" type="submit">${t("settings.save")}</button>
      </form>
    </div>
  `;

  document.getElementById("settings-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const payload = {};
    for (const [k, v] of fd.entries()) {
      if (v && String(v).trim()) payload[k] = v;
    }
    try {
      const updated = await API.request("/settings/", { method: "PUT", body: payload });
      const oldCurrency = state.user?.currency;
      state.user = updated;
      document.getElementById("user-chip").textContent = `${updated.name} · ${updated.currency}`;
      // If currency changed, refresh the FX rate so money() converts properly.
      if (updated.currency !== oldCurrency) {
        await loadFxRate();
      }
      toast(t("settings.saved"), "success");
    } catch (e) { toast(e.message, "error"); }
  };

  document.getElementById("alerts-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const roiEl = document.getElementById("roi-thresh");
    const ddEl = document.getElementById("dd-thresh");
    try {
      // roi_below
      if (roiEl.dataset.existing) await API.request(`/alerts/${roiEl.dataset.existing}`, { method: "DELETE" });
      await API.request("/alerts/", { method: "POST", body: { type: "roi_below", threshold: parseFloat(roiEl.value), scope: "portfolio" } });
      // drawdown_above
      if (ddEl.dataset.existing) await API.request(`/alerts/${ddEl.dataset.existing}`, { method: "DELETE" });
      await API.request("/alerts/", { method: "POST", body: { type: "drawdown_above", threshold: parseFloat(ddEl.value), scope: "portfolio" } });
      toast(t("settings.saved"), "success");
      render(document.getElementById("view-root"));
    } catch (e) { toast(e.message, "error"); }
  };
}
