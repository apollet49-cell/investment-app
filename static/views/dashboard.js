import { API, state, money, pct, spinner, toast, escapeHtml, onViewCleanup } from "/static/app.js";
import { t } from "/static/i18n.js";

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
  root.innerHTML = `<div style="text-align:center;padding:40px">${spinner(true)}</div>`;
  let data;
  try {
    data = await API.request("/dashboard/summary");
  } catch (err) {
    root.innerHTML = `<div class="alert-banner error">${err.message}</div>`;
    return;
  }

  // Schedule the next live refresh (cleared on view change via onViewCleanup).
  const refreshTimer = setTimeout(() => render(root), 60000);
  onViewCleanup(() => clearTimeout(refreshTimer));
  if (!data.total_invested && !data.current_value) {
    root.innerHTML = emptyState();
    document.getElementById("dash-empty-add")?.addEventListener("click", () => location.hash = "#/investments");
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

  root.innerHTML = `
    ${alerts}
    <div class="summary-grid">
      ${summaryCard(t("dashboard.total_invested"), money(data.total_invested))}
      ${summaryCard(t("dashboard.current_value"), money(data.current_value))}
      ${summaryCard(t("dashboard.total_roi"), pct(data.total_roi_pct), roiClass)}
      ${bp
        ? bestPerformerCard(t("dashboard.best_performer"), bp.name, pct(bp.roi_pct), bpRoiClass)
        : summaryCard(t("dashboard.best_performer"), "—")}
      ${diversificationCard(div)}
    </div>
    <div class="chart-grid">
      <div class="card chart-card">
        <div class="chart-header">
          <h3>${t("dashboard.portfolio_over_time")}</h3>
          <span class="live-badge"><span class="live-dot"></span>${t("dashboard.live")}</span>
        </div>
        <div class="chart-canvas-wrap"><canvas id="chart-portfolio"></canvas></div>
      </div>
      <div class="card chart-card">
        <h3>${t("dashboard.asset_allocation")}</h3>
        <div class="chart-canvas-wrap"><canvas id="chart-allocation"></canvas></div>
      </div>
    </div>
    <div class="card chart-card">
      <h3>${t("dashboard.monthly_returns")}</h3>
      <div class="chart-canvas-wrap compact"><canvas id="chart-monthly"></canvas></div>
    </div>
  `;

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

  // Wire the diversification card expand/collapse
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

function diversificationCard(div) {
  const label = t("dashboard.diversification");
  if (!div || div.score == null) {
    return summaryCard(label, "—");
  }
  const score = div.score;
  const color = score >= 75 ? "var(--success)" : score >= 50 ? "var(--warning)" : "var(--danger)";
  const id = `div-card-${Math.random().toString(36).slice(2, 8)}`;
  // Render the breakdown collapsed; expanded via click.
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
  return `
  <div class="summary-card div-card" id="${id}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div class="label">${label}</div>
      <button class="div-toggle" data-target="${id}" style="background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:11px">⌄</button>
    </div>
    <div class="value" style="color:${color}">${score.toFixed(0)}<span style="font-size:14px;color:var(--text-muted);font-family:var(--font-sans)"> / 100</span></div>
    <div class="sub" style="font-size:11px;margin-top:6px">${escapeHtml(div.message || "")}</div>
    <div class="div-breakdown" style="display:none;margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin-bottom:6px">Top positions</div>
      ${topRows || '<div style="color:var(--text-muted);font-size:12px">—</div>'}
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin:10px 0 6px">By asset type</div>
      ${typeRows || '<div style="color:var(--text-muted);font-size:12px">—</div>'}
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
      <button id="dash-empty-add" class="btn btn-primary">${t("dashboard.add_investment")}</button>
    </div>`;
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

function buildAllocationChart(byType) {
  const ctx = document.getElementById("chart-allocation");
  if (!ctx || !window.Chart) return;
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
