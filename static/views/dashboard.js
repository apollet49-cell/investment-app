import { API, state, money, pct, spinner, toast, escapeHtml, onViewCleanup } from "/static/app.js";
import { t } from "/static/i18n.js";

// Persist the active dashboard tab across renders (auto-refresh re-renders
// every 60s; without this the user gets snapped back to "allocation").
// Reset by `resetActiveTab()` on logout so the next user starts fresh.
let activeTab = "allocation";
export function resetActiveTab() { activeTab = "allocation"; }

// Muted earth-tone palette to match the beige / taupe theme.
const TYPE_COLORS = {
  stock: "#8a7558",        // taupe
  real_estate: "#6b7d5e",  // sage
  crypto: "#b8945e",       // warm amber
  bond: "#7a8b9a",         // muted slate
  etf: "#9d7f8f",          // dusty mauve
  startup: "#a56551",      // terracotta
};

export async function render(root) {
  // Destroy any previous Chart.js instances before redrawing — auto-refresh
  // calls render(root) again every 60s.
  for (const k of Object.keys(state.charts)) {
    try { state.charts[k]?.destroy?.(); } catch (_) {}
    delete state.charts[k];
  }
  // Guard against the user navigating away mid-fetch. Single cleanup
  // closure that captures both `cancelled` and `refreshTimer` — register
  // it once so the second onViewCleanup() call below doesn't clobber the
  // earlier one (the runtime keeps only the most recently registered fn).
  let cancelled = false;
  let refreshTimer = null;
  onViewCleanup(() => {
    cancelled = true;
    if (refreshTimer) clearTimeout(refreshTimer);
  });

  root.innerHTML = `<div style="text-align:center;padding:40px">${spinner(true)}</div>`;
  let data;
  try {
    data = await API.request("/dashboard/summary");
  } catch (err) {
    if (cancelled) return;
    root.innerHTML = `<div class="alert-banner error">${err.message}</div>`;
    return;
  }
  if (cancelled) return;

  // Schedule the next live refresh — cleanup above clears it. We skip the
  // refresh entirely when the tab is hidden (mobile / background tab), so a
  // user with the dashboard tab parked overnight doesn't fire 1440 useless
  // network requests. The interval resumes naturally on the next render
  // after the user comes back to the tab and the visibilitychange listener
  // fires it.
  if (document.visibilityState === "visible") {
    refreshTimer = setTimeout(() => { if (!cancelled) render(root); }, 60000);
  } else {
    const onVisible = () => {
      if (document.visibilityState === "visible" && !cancelled) {
        document.removeEventListener("visibilitychange", onVisible);
        render(root);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    onViewCleanup(() => document.removeEventListener("visibilitychange", onVisible));
  }
  if (!data.total_invested && !data.current_value) {
    root.innerHTML = emptyState();
    document.getElementById("dash-empty-add")?.addEventListener("click", () => location.hash = "#/investments");
    document.getElementById("dash-empty-seed")?.addEventListener("click", loadDemoData);
    return;
  }

  const roiClass = data.total_roi_pct >= 0 ? "positive" : "negative";
  const alerts = (data.triggered_alerts || []).map(a => `
    <div class="alert-banner">
      <span>${t("alerts." + (a.type === "roi_below" ? "type_roi_below" : "type_drawdown_above"))} (${pct(a.threshold)})</span>
      <button data-id="${a.id}" class="dismiss-alert">✕</button>
    </div>`).join("");

  const bp = data.best_performer;
  const bpRoiClass = bp ? (bp.roi_pct >= 0 ? "positive" : "negative") : "";
  const div = data.diversification;

  // ---- 4 hero KPIs at the top ----
  const netWorthDelta = data.current_value - data.total_invested;
  const netWorthDeltaClass = netWorthDelta >= 0 ? "positive" : "negative";
  const netWorthDeltaSign = netWorthDelta >= 0 ? "+" : "";

  root.innerHTML = `
    ${alerts}
    <div class="summary-grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
      <div class="summary-card">
        <div class="label">${t("dashboard.net_worth")}</div>
        <div class="value" style="font-size:26px">${money(data.current_value)}</div>
        <div class="sub ${netWorthDeltaClass}" style="font-size:12px;margin-top:6px">${netWorthDeltaSign}${money(netWorthDelta)} · ${pct(data.total_roi_pct)}</div>
      </div>
      <div class="summary-card" id="perf-card">
        <div class="label">${t("dashboard.xirr_vs_sp")}</div>
        <div class="value" id="perf-xirr" style="font-size:26px">—</div>
        <div class="sub" id="perf-sub" style="font-size:12px;margin-top:6px;color:var(--text-muted)">${t("dashboard.xirr_loading")}</div>
      </div>
      ${riskCard(div)}
      <div class="summary-card" id="fire-card">
        <div class="label">${t("dashboard.years_to_fire")}</div>
        <div class="value" id="fire-years" style="font-size:26px">—</div>
        <div class="sub" id="fire-sub" style="font-size:12px;margin-top:6px;color:var(--text-muted)">${t("dashboard.fire_loading")}</div>
      </div>
    </div>

    <div class="card chart-card">
      <div class="chart-header">
        <h3>${t("dashboard.portfolio_over_time")}</h3>
        <span class="live-badge"><span class="live-dot"></span>${t("dashboard.live")}</span>
      </div>
      <div class="chart-canvas-wrap"><canvas id="chart-portfolio" role="img" aria-label="${t("dashboard.portfolio_over_time")}"></canvas></div>
    </div>

    <div class="card" style="padding:0">
      <div class="dash-tabs" role="tablist" style="display:flex;gap:2px;border-bottom:1px solid var(--border);overflow-x:auto">
        ${["allocation","performance","risk","income"].map(tab => {
          const isActive = tab === activeTab;
          return `<button class="dash-tab${isActive ? ' active' : ''}" role="tab" aria-selected="${isActive}" aria-controls="dash-panel-${tab}" data-tab="${tab}" style="padding:12px 18px;background:transparent;border:none;border-bottom:2px solid ${isActive ? 'var(--primary)' : 'transparent'};font-weight:${isActive ? '500' : '400'};color:${isActive ? 'var(--text)' : 'var(--text-muted)'};cursor:pointer;font-size:13px">${t(`dashboard.tab_${tab}`)}</button>`;
        }).join("")}
      </div>
      <div style="padding:18px">
        <div class="dash-panel" id="dash-panel-allocation" role="tabpanel" data-panel="allocation" style="display:${activeTab === 'allocation' ? '' : 'none'}">
          <div class="chart-grid">
            <div class="chart-card" style="padding:0;border:none">
              <h4 style="margin:0 0 10px 0">${t("dashboard.asset_allocation")}</h4>
              <div class="chart-canvas-wrap"><canvas id="chart-allocation" role="img" aria-label="${t("dashboard.asset_allocation")}"></canvas></div>
            </div>
            <div class="chart-card" style="padding:0;border:none">
              <h4 style="margin:0 0 10px 0">${t("dashboard.diversification")}</h4>
              <div id="diversification-host">${diversificationInline(div)}</div>
            </div>
          </div>
        </div>
        <div class="dash-panel" id="dash-panel-performance" role="tabpanel" data-panel="performance" style="display:${activeTab === 'performance' ? '' : 'none'}">
          <h4 style="margin:0 0 10px 0">${t("dashboard.monthly_returns")}</h4>
          <div class="chart-canvas-wrap compact"><canvas id="chart-monthly" role="img" aria-label="${t("dashboard.monthly_returns")}"></canvas></div>
          ${bp ? `<div style="margin-top:14px;padding:12px;background:var(--surface);border-radius:8px">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin-bottom:6px">${t("dashboard.best_performer")}</div>
            <div style="font-size:18px;font-family:var(--font-serif)">${escapeHtml(bp.name)}</div>
            <div style="color:${bp.roi_pct >= 0 ? 'var(--success)' : 'var(--danger)'};font-weight:500;margin-top:4px">${pct(bp.roi_pct)}</div>
          </div>` : ""}
        </div>
        <div class="dash-panel" id="dash-panel-risk" role="tabpanel" data-panel="risk" style="display:${activeTab === 'risk' ? '' : 'none'}">
          <div class="chart-grid">
            <div style="padding:0">
              <h4 style="margin:0 0 10px 0">${t("dashboard.stress_tests")}</h4>
              <div id="stress-test-body" style="text-align:center;padding:14px;color:var(--text-muted)">${spinner()}</div>
            </div>
            <div style="padding:0">
              ${carbonCard(data.carbon)}
            </div>
          </div>
        </div>
        <div class="dash-panel" id="dash-panel-income" role="tabpanel" data-panel="income" style="display:${activeTab === 'income' ? '' : 'none'}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <h4 style="margin:0">${t("dashboard.dividend_calendar")}</h4>
            <span style="color:var(--text-muted);font-size:12px" id="dividend-annual-summary"></span>
          </div>
          <div id="dividend-calendar-body" style="text-align:center;padding:14px;color:var(--text-muted)">${spinner()}</div>
        </div>
      </div>
    </div>
  `;

  // Wire dashboard tabs — persists active tab in module-scoped variable so
  // the 60s auto-refresh doesn't snap users back to "allocation".
  for (const btn of root.querySelectorAll(".dash-tab")) {
    btn.onclick = () => {
      activeTab = btn.dataset.tab;
      for (const b of root.querySelectorAll(".dash-tab")) {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", String(active));
        b.style.borderBottomColor = active ? "var(--primary)" : "transparent";
        b.style.color = active ? "var(--text)" : "var(--text-muted)";
        b.style.fontWeight = active ? "500" : "400";
      }
      for (const p of root.querySelectorAll(".dash-panel")) {
        p.style.display = p.dataset.panel === activeTab ? "" : "none";
      }
      // Chart.js measures the canvas parent at construction time. If the
      // monthly chart was built while its panel had display:none, the canvas
      // is 0×0 — calling resize() now that the panel is visible re-measures.
      try {
        if (activeTab === "performance") state.charts.monthly?.resize?.();
        if (activeTab === "allocation") state.charts.allocation?.resize?.();
      } catch (_) {}
    };
  }

  // Wire dismiss
  for (const btn of root.querySelectorAll(".dismiss-alert")) {
    btn.onclick = async () => {
      try { await API.request(`/alerts/${btn.dataset.id}/dismiss`, { method: "POST" }); btn.parentElement.remove(); }
      catch (e) { toast(e.message, "error"); }
    };
  }

  buildPortfolioChart(data.portfolio_over_time);
  buildAllocationChart(data.by_type);
  buildMonthlyChart(data.monthly_returns);
  loadStressTest();
  loadDividendCalendar();
  loadPerformance(() => cancelled);
  loadHistoryAndBenchmark(() => cancelled);
  loadFireYears(() => cancelled);

  // Wire the diversification card expand/collapse (still used inside tabs)
  for (const btn of root.querySelectorAll(".div-toggle")) {
    btn.onclick = () => {
      const card = document.getElementById(btn.dataset.target);
      const panel = card?.querySelector(".div-breakdown");
      if (!panel) return;
      const show = panel.style.display === "none";
      panel.style.display = show ? "block" : "none";
      btn.textContent = show ? "⌃" : "⌄";
    };
  }
}

async function loadFireYears(isCancelled) {
  const yEl = document.getElementById("fire-years");
  const sEl = document.getElementById("fire-sub");
  if (!yEl || !sEl) return;
  // If FX rate fetch failed for a non-USD user, the conversion would silently
  // use 1.0 and give a misleading "years to FIRE". Surface that to the user
  // instead — they should refresh after FX comes back.
  if (state.fxFailed) {
    yEl.textContent = "—";
    sEl.textContent = t("dashboard.fx_failed");
    return;
  }
  try {
    const fx = state.fxRate || 1.0;
    const expensesUsd = Math.round(2500 / fx);
    const savingsUsd = Math.round(1500 / fx);
    const data = await API.request(`/planning/fire?monthly_expenses=${expensesUsd}&monthly_savings=${savingsUsd}&expected_return_pct=7&target_multiplier=25`);
    if (isCancelled()) return;
    if (data.already_fire) {
      yEl.textContent = "🎉";
      sEl.textContent = t("dashboard.fire_already");
    } else if (data.years_to_fire == null) {
      yEl.textContent = "—";
      sEl.textContent = t("dashboard.fire_unreachable");
    } else {
      yEl.textContent = data.years_to_fire.toFixed(1);
      sEl.textContent = `${t("dashboard.fire_at_25x")} (${(data.progress_pct || 0).toFixed(0)}% ${t("dashboard.fire_progress")})`;
    }
  } catch (_) {
    if (sEl) sEl.textContent = t("dashboard.fire_unreachable");
  }
}

function diversificationInline(div) {
  if (!div || div.score == null) return `<p style="color:var(--text-muted)">—</p>`;
  const score = div.score;
  const color = score >= 75 ? "var(--success)" : score >= 50 ? "var(--warning)" : "var(--danger)";
  const topRows = (div.top_positions || []).slice(0, 5).map(p => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">
      <span style="color:var(--text-muted)">${escapeHtml(p.name)}</span>
      <strong>${p.weight_pct.toFixed(1)}%</strong>
    </div>`).join("");
  return `
    <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px">
      <div style="font-size:28px;color:${color};font-family:var(--font-serif)">${score.toFixed(0)}</div>
      <div style="color:var(--text-muted);font-size:12px">/ 100</div>
    </div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">${escapeHtml(div.message || "")}</div>
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin-bottom:6px">${t("dashboard.top_positions") || "Top positions"}</div>
    ${topRows || `<div style="color:var(--text-muted);font-size:12px">—</div>`}
  `;
}

function summaryCard(label, value, cls = "") {
  return `<div class="summary-card"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
}

function bestPerformerCard(label, name, roiText, roiClass) {
  return `<div class="summary-card">
    <div class="label">${label}</div>
    <div class="value compact">${escapeHtml(name)}</div>
    <div class="sub ${roiClass}" style="font-weight:500;font-size:13px;margin-top:4px">${roiText}</div>
  </div>`;
}

function riskCard(div) {
  const label = t("dashboard.risk_score");
  if (!div || div.risk_score == null) return summaryCard(label, "—");
  const risk = div.risk_score;
  const clamped = Math.max(0, Math.min(100, risk));
  const tone = risk <= 25 ? "var(--success)" : risk <= 60 ? "var(--warning)" : "var(--danger)";
  const tier = risk <= 25 ? t("dashboard.risk_low")
             : risk <= 60 ? t("dashboard.risk_medium")
             : t("dashboard.risk_high");
  const factors = (div.risk_factors || []).slice(0, 2)
    .map(f => `<div style="font-size:11px;color:var(--text-muted);padding:2px 0">• ${escapeHtml(f)}</div>`)
    .join("");
  return `<div class="summary-card">
    <div class="label">${label}</div>
    <div class="value" style="color:${tone};display:flex;align-items:baseline;gap:6px">
      ${risk.toFixed(0)}<span style="font-size:12px;color:var(--text-muted);font-family:var(--font-sans)"> / 100</span>
      <span style="font-size:12px;color:${tone};font-family:var(--font-sans);margin-left:4px">${tier}</span>
    </div>
    <div class="risk-gauge"><div class="marker" style="left:${clamped}%"></div></div>
    <div class="risk-gauge-scale"><span>${t("dashboard.risk_low")}</span><span>${t("dashboard.risk_medium")}</span><span>${t("dashboard.risk_high")}</span></div>
    ${factors ? `<div style="margin-top:8px">${factors}</div>` : ""}
  </div>`;
}

function diversificationCard(div) {
  const label = t("dashboard.diversification");
  if (!div || div.score == null) {
    return summaryCard(label, "—");
  }
  const score = div.score;
  const color = score >= 75 ? "var(--success)" : score >= 50 ? "var(--warning)" : "var(--danger)";
  const id = `div-card-${Math.random().toString(36).slice(2, 8)}`;
  const topRows = (div.top_positions || []).slice(0, 5).map(p => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">
      <span style="color:var(--text-muted)">${escapeHtml(p.name)}</span>
      <strong>${p.weight_pct.toFixed(1)}%</strong>
    </div>`).join("");
  const typeRows = Object.entries(div.type_distribution || {}).map(([k, v]) => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">
      <span style="color:var(--text-muted)">${escapeHtml(t(`investments.types.${k}`) || k)}</span>
      <strong>${v.toFixed(1)}%</strong>
    </div>`).join("");
  const sectorRows = Object.entries(div.sector_distribution || {}).map(([k, v]) => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">
      <span style="color:var(--text-muted)">${escapeHtml(k)}</span>
      <strong>${v.toFixed(1)}%</strong>
    </div>`).join("");
  const countryRows = Object.entries(div.country_distribution || {}).map(([k, v]) => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">
      <span style="color:var(--text-muted)">${escapeHtml(k)}</span>
      <strong>${v.toFixed(1)}%</strong>
    </div>`).join("");
  const riskFactors = (div.risk_factors || []).map(rf => `
    <div style="font-size:12px;padding:3px 0;color:var(--danger)">• ${escapeHtml(rf)}</div>`).join("");
  return `
  <div class="summary-card div-card" id="${id}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div class="label">${label}</div>
      <button class="div-toggle" data-target="${id}" style="background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:11px">⌄</button>
    </div>
    <div class="value" style="color:${color}">${score.toFixed(0)}<span style="font-size:14px;color:var(--text-muted);font-family:var(--font-sans)"> / 100</span></div>
    <div class="sub" style="font-size:11px;margin-top:6px">${escapeHtml(div.message || "")}</div>
    <div class="div-breakdown" style="display:none;margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
      ${riskFactors ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin-bottom:6px">${t("dashboard.risk_factors")}</div>${riskFactors}<div style="height:8px"></div>` : ""}
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin-bottom:6px">Top positions</div>
      ${topRows || '<div style="color:var(--text-muted);font-size:12px">—</div>'}
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin:10px 0 6px">By asset type</div>
      ${typeRows || '<div style="color:var(--text-muted);font-size:12px">—</div>'}
      ${sectorRows ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin:10px 0 6px">By sector (stocks)</div>${sectorRows}` : ""}
      ${countryRows ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin:10px 0 6px">By country</div>${countryRows}` : ""}
    </div>
  </div>`;
}

function carbonCard(carbon) {
  const label = t("dashboard.carbon");
  if (!carbon || carbon.total_tco2e_year == null) {
    return summaryCard(label, "—");
  }
  const total = carbon.total_tco2e_year;
  const eq = carbon.equivalents || {};
  const color = total < 1 ? "var(--success)" : total < 5 ? "var(--warning)" : "var(--danger)";
  const id = `carbon-card-${Math.random().toString(36).slice(2, 8)}`;
  const breakdownRows = (carbon.breakdown || []).slice(0, 8).map(b => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">
      <span style="color:var(--text-muted)">${escapeHtml(b.name)} <span style="opacity:0.6">${escapeHtml(b.basis)}</span></span>
      <strong>${b.emissions_tco2e_year.toFixed(2)} t</strong>
    </div>`).join("");
  return `
  <div class="summary-card div-card" id="${id}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div class="label">${label}</div>
      <button class="div-toggle" data-target="${id}" style="background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:11px">⌄</button>
    </div>
    <div class="value" style="color:${color}">${total.toFixed(1)}<span style="font-size:14px;color:var(--text-muted);font-family:var(--font-sans)"> tCO₂e/yr</span></div>
    <div class="sub" style="font-size:11px;margin-top:6px">${escapeHtml(carbon.message || "")}</div>
    <div class="div-breakdown" style="display:none;margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin-bottom:8px">${t("dashboard.carbon_equivalents")}</div>
      <div style="font-size:12px;padding:3px 0">🚗 ≈ ${(eq.car_km || 0).toLocaleString()} ${t("dashboard.carbon_car_km")}</div>
      <div style="font-size:12px;padding:3px 0">✈️ ≈ ${eq.transatlantic_flights || 0} ${t("dashboard.carbon_flights")}</div>
      <div style="font-size:12px;padding:3px 0">🇫🇷 ${eq.french_avg_pct || 0}% ${t("dashboard.carbon_french_avg")}</div>
      ${breakdownRows ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin:12px 0 6px">${t("dashboard.carbon_top_emitters")}</div>${breakdownRows}` : ""}
    </div>
  </div>`;
}

function emptyState() {
  return `
    <div class="card empty-state">
      <svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="3">
        <rect x="10" y="40" width="12" height="30" rx="2"/>
        <rect x="34" y="25" width="12" height="45" rx="2"/>
        <rect x="58" y="10" width="12" height="60" rx="2"/>
      </svg>
      <h3>${t("dashboard.no_investments_title")}</h3>
      <p>${t("dashboard.no_investments_sub")}</p>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:14px">
        <button id="dash-empty-add" class="btn btn-primary">${t("dashboard.add_investment")}</button>
        <button id="dash-empty-seed" class="btn btn-ghost">${t("dashboard.try_demo_data")}</button>
      </div>
      <p style="color:var(--text-muted);font-size:12px;margin-top:14px;max-width:420px;margin-left:auto;margin-right:auto">${t("dashboard.try_demo_hint")}</p>
    </div>`;
}

async function loadDemoData() {
  const btn = document.getElementById("dash-empty-seed");
  if (!btn) return;
  if (!confirm(t("dashboard.try_demo_confirm"))) return;
  btn.disabled = true;
  btn.textContent = t("dashboard.try_demo_loading");
  try {
    await API.request("/investments/seed-demo", { method: "POST", body: { confirm_wipe: true } });
    toast(t("dashboard.try_demo_done"), "success");
    // Re-render the dashboard from scratch so the new data shows up.
    setTimeout(() => location.reload(), 600);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = t("dashboard.try_demo_data");
    toast(e.message || "Seed failed", "error");
  }
}

async function loadDividendCalendar() {
  const host = document.getElementById("dividend-calendar-body");
  const summaryEl = document.getElementById("dividend-annual-summary");
  if (!host) return;
  try {
    const data = await API.request("/dividends/calendar");
    if (summaryEl && data.annual_income_estimate_usd) {
      summaryEl.innerHTML = `${t("dashboard.dividend_estimate")}: <strong style="color:var(--text)">${money(data.annual_income_estimate_usd)}/yr</strong>`;
    }
    if (!data.upcoming || !data.upcoming.length) {
      host.innerHTML = `<div style="color:var(--text-muted);font-size:13px">${t("dashboard.no_upcoming_dividends")}</div>`;
      return;
    }
    host.innerHTML = `
      <div class="table-wrap"><table class="data" style="font-size:12.5px">
        <thead><tr>
          <th>${t("dashboard.div_asset")}</th>
          <th>${t("dashboard.div_next_ex")}</th>
          <th style="text-align:right">${t("dashboard.div_yield")}</th>
          <th style="text-align:right">${t("dashboard.div_next_payment")}</th>
        </tr></thead>
        <tbody>
          ${data.upcoming.slice(0, 10).map(d => `<tr>
            <td><strong>${escapeHtml(d.name)}</strong> <span style="color:var(--text-muted);font-size:11px">${escapeHtml(d.symbol)}</span></td>
            <td>${d.next_ex_div || "—"}</td>
            <td style="text-align:right">${d.annual_yield_pct != null ? d.annual_yield_pct.toFixed(2) + "%" : "—"}</td>
            <td style="text-align:right">${d.estimated_next_payment_usd != null ? money(d.estimated_next_payment_usd) : "—"}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>`;
  } catch (e) {
    host.innerHTML = `<div class="alert-banner error" style="margin:0">${escapeHtml(e.message)}</div>`;
  }
}

async function loadStressTest() {
  const host = document.getElementById("stress-test-body");
  if (!host) return;
  try {
    const data = await API.request("/planning/stress-test");
    if (!data.scenarios || !data.scenarios.length) {
      host.innerHTML = `<div style="color:var(--text-muted);font-size:13px">${t("dashboard.no_positions_for_stress")}</div>`;
      return;
    }
    host.innerHTML = `
      <div style="margin-bottom:8px;font-size:13px;color:var(--text-muted)">
        ${t("dashboard.baseline")}: <strong style="color:var(--text)">${money(data.baseline)}</strong>
      </div>
      <div class="table-wrap"><table class="data" style="font-size:12.5px">
        <thead><tr>
          <th>${t("dashboard.scenario")}</th>
          <th style="text-align:right">${t("dashboard.under_value")}</th>
          <th style="text-align:right">${t("dashboard.loss")}</th>
          <th style="text-align:right">${t("dashboard.impact")}</th>
        </tr></thead>
        <tbody>
        ${data.scenarios.map(s => `
          <tr>
            <td><strong>${escapeHtml(s.label)}</strong><div style="color:var(--text-muted);font-size:11px">${escapeHtml(s.description)}</div></td>
            <td style="text-align:right">${money(s.value)}</td>
            <td style="text-align:right;color:${s.loss < 0 ? 'var(--danger)' : 'var(--text-muted)'}">${s.loss < 0 ? money(s.loss) : '—'}</td>
            <td style="text-align:right">
              <span class="badge ${s.loss_pct <= -25 ? 'red' : s.loss_pct <= -10 ? 'yellow' : 'gray'}" style="font-variant-numeric:tabular-nums">${s.loss_pct.toFixed(1)}%</span>
            </td>
          </tr>`).join("")}
        </tbody>
      </table></div>`;
  } catch (e) {
    host.innerHTML = `<div class="alert-banner error" style="margin:0">${escapeHtml(e.message)}</div>`;
  }
}

function buildPortfolioChart(points) {
  const ctx = document.getElementById("chart-portfolio");
  if (!ctx || !window.Chart) return;
  state.charts.portfolio = new window.Chart(ctx, {
    type: "line",
    data: {
      labels: points.map(p => p.date),
      datasets: [{
        label: t("dashboard.portfolio_over_time"),
        data: points.map(p => p.value),
        borderColor: "#8a7558",
        backgroundColor: "rgba(138, 117, 88, 0.08)",
        borderWidth: 1.5,
        fill: true, tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: false } },
    },
  });
}

async function loadPerformance(isCancelled) {
  try {
    const data = await API.request("/dashboard/performance");
    if (isCancelled()) return;
    const xirrEl = document.getElementById("perf-xirr");
    const subEl = document.getElementById("perf-sub");
    if (!xirrEl || !subEl) return;
    if (data.xirr_pct != null) {
      xirrEl.textContent = pct(data.xirr_pct);
      xirrEl.classList.add(data.xirr_pct >= 0 ? "positive" : "negative");
    } else {
      xirrEl.textContent = "—";
    }
    // Sub-line: TWR + try to compute vs S&P 500 from the history endpoint.
    const parts = [];
    if (data.twr_pct != null) parts.push(`${t("dashboard.twr")}: ${pct(data.twr_pct)}`);
    try {
      const h = await API.request("/dashboard/history?days=365&benchmark=^GSPC");
      if (!isCancelled() && h?.portfolio?.length > 1 && h.benchmark?.length > 0) {
        const youEnd = h.portfolio[h.portfolio.length - 1].normalized;
        const benchEnd = h.benchmark[h.benchmark.length - 1].normalized;
        const diff = youEnd - benchEnd;
        const sign = diff >= 0 ? "+" : "";
        const cls = diff >= 0 ? "positive" : "negative";
        parts.push(`<span class="${cls}">${sign}${diff.toFixed(1)} ${t("dashboard.vs_sp500")}</span>`);
      }
    } catch (_) {}
    if (parts.length === 0) parts.push(t("dashboard.xirr_no_data"));
    subEl.innerHTML = parts.join(" · ");
  } catch (e) {
    const subEl = document.getElementById("perf-sub");
    if (subEl) subEl.textContent = t("dashboard.xirr_no_data");
  }
}

async function loadHistoryAndBenchmark(isCancelled) {
  let history;
  try {
    history = await API.request("/dashboard/history?days=365&benchmark=^GSPC");
  } catch (e) {
    return; // keep the interpolated chart already drawn
  }
  if (isCancelled()) return;
  if (!history?.portfolio?.length || history.portfolio.length < 2) return;

  // Re-draw the portfolio chart with the real snapshot series + S&P overlay.
  const ctx = document.getElementById("chart-portfolio");
  if (!ctx || !window.Chart) return;
  try { state.charts.portfolio?.destroy?.(); } catch (_) {}

  // Both series use the snapshot dates as the x-axis; map benchmark by date.
  const labels = history.portfolio.map(p => p.date);
  const portfolioData = history.portfolio.map(p => p.normalized);
  const benchByDate = {};
  for (const b of history.benchmark || []) benchByDate[b.date] = b.normalized;
  // Forward-fill benchmark on weekends/holidays for visual continuity.
  let lastBench = null;
  const benchmarkData = labels.map(d => {
    if (benchByDate[d] != null) lastBench = benchByDate[d];
    return lastBench;
  });

  state.charts.portfolio = new window.Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: t("dashboard.your_portfolio"),
          data: portfolioData,
          borderColor: "#8a7558",
          backgroundColor: "rgba(138, 117, 88, 0.08)",
          borderWidth: 1.8, fill: true, tension: 0.3,
          pointRadius: 0, pointHoverRadius: 4,
        },
        {
          label: `${t("dashboard.benchmark")} (${history.benchmark_symbol})`,
          data: benchmarkData,
          borderColor: "#6b7d5e",
          borderDash: [4, 4],
          borderWidth: 1.3, fill: false, tension: 0.3,
          pointRadius: 0, pointHoverRadius: 4,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: "bottom", labels: { font: { size: 11 }, boxWidth: 14 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1)}` } },
      },
      scales: {
        y: {
          beginAtZero: false,
          title: { display: true, text: t("dashboard.base_100"), font: { size: 10 }, color: "var(--text-muted)" },
        },
      },
    },
  });
}

function buildAllocationChart(byType) {
  const ctx = document.getElementById("chart-allocation");
  if (!ctx || !window.Chart) return;
  try { state.charts.allocation?.destroy?.(); } catch (_) {}
  const labels = Object.keys(byType);
  const data = Object.values(byType);
  state.charts.allocation = new window.Chart(ctx, {
    type: "doughnut",
    data: {
      labels: labels.map(l => t(`investments.types.${l}`)),
      datasets: [{
        data,
        backgroundColor: labels.map(l => TYPE_COLORS[l] || "#a89683"),
        borderColor: "#faf7f2",
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: "65%",
      plugins: { legend: { position: "bottom", labels: { font: { size: 12 }, boxWidth: 10 } } },
    },
  });
}

function buildMonthlyChart(rows) {
  const ctx = document.getElementById("chart-monthly");
  if (!ctx || !window.Chart) return;
  try { state.charts.monthly?.destroy?.(); } catch (_) {}
  state.charts.monthly = new window.Chart(ctx, {
    type: "bar",
    data: {
      labels: rows.map(r => r.month),
      datasets: [{
        label: t("dashboard.monthly_returns"),
        data: rows.map(r => r.return_pct),
        backgroundColor: rows.map(r => r.return_pct >= 0 ? "#6b7d5e" : "#a56551"),
        borderRadius: 2,
      }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });
}
