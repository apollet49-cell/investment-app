// Dashboard view: orchestrates the hero stats, charts, tabbed panels,
// and async card loaders. The actual rendering primitives live in
// ./dashboard/*.js — this file decides what shows up, in what order, and
// wires the tab/dismiss/expand handlers.
import { API, cachedGet, seedCache, skeleton, state, money, pct, spinner, toast, escapeHtml, onViewCleanup, animateNumber } from "/static/app.js";
import { t } from "/static/i18n.js";

import {
  buildAllocationChart,
  buildMonthlyChart,
  buildPortfolioChart,
  loadHistoryAndBenchmark,
} from "./dashboard/charts.js";
import {
  carbonCard,
  carbonTopEmittersTable,
  riskCard,
  diversificationInline,
} from "./dashboard/cards.js";
import { emptyState, heroInsight, loadDemoData } from "./dashboard/insights.js";
import {
  loadDividendCalendar,
  loadFireYears,
  loadPerformance,
  loadRealRisk,
  loadStressTest,
} from "./dashboard/sub_loaders.js";

// Persist the active dashboard tab across renders (auto-refresh re-renders
// every 60s; without this the user gets snapped back to "allocation").
// Reset by `resetActiveTab()` on logout so the next user starts fresh.
let activeTab = "allocation";
export function resetActiveTab() { activeTab = "allocation"; }

export async function render(root) {
  // Destroy any previous Chart.js instances before redrawing — auto-refresh
  // calls render(root) again every 60s.
  for (const k of Object.keys(state.charts)) {
    try { state.charts[k]?.destroy?.(); } catch (_) {}
    delete state.charts[k];
  }
  // Two layers of cancellation. The `cancelled` closure is set by the
  // view-cleanup that renderRoute() fires synchronously on navigation.
  // The DOM-attached route token (set on view-root by renderRoute) is
  // the belt-and-braces check: even if a stale async resolves BEFORE
  // its cleanup runs (rare but observed), the token tells us "this
  // render-root now belongs to a different route — abort the paint."
  let cancelled = false;
  let refreshTimer = null;
  onViewCleanup(() => {
    cancelled = true;
    if (refreshTimer) clearTimeout(refreshTimer);
  });
  // Capture the renderRoute call's id. Any subsequent renderRoute (even
  // dashboard → fire → dashboard, which would re-match dataset.route)
  // bumps the id, so stale async work from this render bails cleanly.
  const myRenderId = root.dataset.renderId;
  const stillOwnsRoot = () => !cancelled && root.dataset.renderId === myRenderId;

  // Stale-while-revalidate: on every visit AFTER the first one in this
  // session, we already have a cached /dashboard/summary in sessionStorage,
  // so we render INSTANTLY from cache and let the background refresh fire
  // a fresh fetch. Spinner only shows on the very first visit per session.
  //
  // On cold cache (no /dashboard/summary entry), we batch-fetch /dashboard/all
  // which returns all 7 sub-endpoints in one HTTP round-trip + warms the
  // SWR cache for each. The secondary cards (FIRE, risk, dividends, perf,
  // history, stress) read their cached entries instead of firing their own
  // calls. Saves 5 round-trips on first visit.
  let data;
  const tokenSuffix = state.token?.slice(-12) || "anon";
  const cacheKey = `swr:${tokenSuffix}:/dashboard/summary`;
  const hasCache = sessionStorage.getItem(cacheKey) !== null;
  if (!hasCache) {
    if (!stillOwnsRoot()) return;
    root.innerHTML = skeleton("kpi");
    // Cold cache: prefetch everything in one shot so the cards don't each
    // wait their turn on the network.
    try {
      const bundle = await API.request("/dashboard/all");
      if (!stillOwnsRoot()) return;
      seedCache("/dashboard/summary", bundle.summary);
      seedCache("/dashboard/performance", bundle.performance);
      seedCache("/dashboard/history?days=365&benchmark=^GSPC", bundle.history);
      seedCache("/dashboard/risk?days=180&benchmark=^GSPC", bundle.risk);
      seedCache(`/planning/fire?monthly_expenses=2500&monthly_savings=1500&expected_return_pct=7&target_multiplier=25`, bundle.fire);
      seedCache("/planning/stress-test", bundle.stress);
      seedCache("/dividends/calendar", bundle.dividends);
    } catch (_) { /* fall back to individual fetches below */ }
  }
  try {
    data = await cachedGet("/dashboard/summary", (fresh) => {
      // Fresh data arrived in the background — re-render. Triple-guarded
      // because this fires from a stale Promise chain that may have
      // outlived navigation: cancelled closure, hash, AND the view-root's
      // current route token must all still point at dashboard.
      if (!stillOwnsRoot()) return;
      if (window.location.hash && window.location.hash !== "#/dashboard") return;
      render(root);
    });
  } catch (err) {
    if (!stillOwnsRoot()) return;
    root.innerHTML = `<div class="alert-banner error">${escapeHtml(err.message)}</div>`;
    return;
  }
  if (!stillOwnsRoot()) return;

  // Schedule the next live refresh — cleanup above clears it. We skip the
  // refresh entirely when the tab is hidden (mobile / background tab), so a
  // user with the dashboard tab parked overnight doesn't fire 1440 useless
  // network requests. The interval resumes naturally on the next render
  // after the user comes back to the tab and the visibilitychange listener
  // fires it.
  if (document.visibilityState === "visible") {
    refreshTimer = setTimeout(() => { if (stillOwnsRoot()) render(root); }, 60000);
  } else {
    const onVisible = () => {
      if (document.visibilityState === "visible" && stillOwnsRoot()) {
        document.removeEventListener("visibilitychange", onVisible);
        render(root);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    onViewCleanup(() => document.removeEventListener("visibilitychange", onVisible));
  }
  if (!data.total_invested && !data.current_value) {
    if (!stillOwnsRoot()) return;
    root.innerHTML = emptyState();
    document.getElementById("dash-empty-add")?.addEventListener("click", () => location.hash = "#/investments");
    document.getElementById("dash-empty-seed")?.addEventListener("click", loadDemoData);
    return;
  }

  const alerts = (data.triggered_alerts || []).map(a => `
    <div class="alert-banner">
      <span>${t("alerts." + (a.type === "roi_below" ? "type_roi_below" : "type_drawdown_above"))} (${pct(a.threshold)})</span>
      <button data-id="${a.id}" class="dismiss-alert">✕</button>
    </div>`).join("");

  const bp = data.best_performer;
  const div = data.diversification;

  // ---- 4 hero KPIs at the top ----
  const netWorthDelta = data.current_value - data.total_invested;
  const netWorthDeltaClass = netWorthDelta >= 0 ? "positive" : "negative";
  const netWorthDeltaSign = netWorthDelta >= 0 ? "+" : "";

  // Last gate before the big DOM write — bail if anything navigated since
  // the cachedGet await above (the loadFxRate / posthog awaits in bootApp
  // run in parallel with this render, so a fast click between them can
  // race past the earlier guards).
  if (!stillOwnsRoot()) return;
  root.innerHTML = `
    ${alerts}
    ${heroInsight(data)}
    <div class="summary-grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
      <div class="summary-card">
        <div class="label">${t("dashboard.net_worth")}</div>
        <div class="value" id="kpi-net-worth" data-target="${data.current_value}" style="font-size:26px">${money(data.current_value)}</div>
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
              ${carbonTopEmittersTable(data.carbon)}
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

  // Count-up animation on the Net Worth KPI. Skipped on auto-refresh
  // (when the user is just sitting on the dashboard the number shouldn't
  // re-animate every minute) — only animates on initial / cache-fresh
  // renders. We detect "initial" by checking if the element was already
  // showing a non-zero value from a previous render.
  const nwEl = document.getElementById("kpi-net-worth");
  if (nwEl && !nwEl.dataset.animated) {
    nwEl.dataset.animated = "1";
    animateNumber(nwEl, data.current_value, {
      duration: 800,
      format: (n) => money(n),
    });
  }

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
  loadRealRisk(() => cancelled);
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
