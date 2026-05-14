import { API, state, money, spinner, toast, escapeHtml, onViewCleanup } from "/static/app.js";
import { t } from "/static/i18n.js";

let monthlyExpenses = 2000;
let monthlySavings = 1000;
let expectedReturn = 7.0;
let multiplier = 25.0;
let debounceTimer = null;

export async function render(root) {
  for (const k of Object.keys(state.charts)) {
    try { state.charts[k]?.destroy?.(); } catch (_) {}
    delete state.charts[k];
  }
  root.innerHTML = `<div style="text-align:center;padding:40px">${spinner(true)}</div>`;
  await refresh(root);
}

async function refresh(root) {
  let cancelled = false;
  onViewCleanup(() => { cancelled = true; });
  let data;
  try {
    data = await API.request(`/planning/fire?monthly_expenses=${monthlyExpenses}&monthly_savings=${monthlySavings}&expected_return_pct=${expectedReturn}&target_multiplier=${multiplier}`);
  } catch (err) {
    if (cancelled) return;
    root.innerHTML = `<div class="alert-banner error">${escapeHtml(err.message)}</div>`;
    return;
  }
  if (cancelled) return;
  draw(root, data);
}

function draw(root, data) {
  const progress = data.progress_pct || 0;
  const years = data.years_to_fire;
  const yearsStr = data.already_fire ? "🎉 " + t("fire.already_fire") : (years == null ? "—" : `${years.toFixed(1)}`);
  const progressColor = progress >= 100 ? "var(--success)" : progress >= 50 ? "var(--warning)" : "var(--primary)";

  root.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">${t("fire.title")}</h3>
      <p style="color:var(--text-muted);font-size:13px;margin:0 0 14px">${t("fire.subtitle")}</p>
      <div class="row">
        <div class="col field">
          <label>${t("fire.monthly_expenses")} (USD)</label>
          <input id="fire-exp" type="number" min="0" step="50" value="${monthlyExpenses}"/>
        </div>
        <div class="col field">
          <label>${t("fire.monthly_savings")} (USD)</label>
          <input id="fire-sav" type="number" min="0" step="50" value="${monthlySavings}"/>
        </div>
        <div class="col field">
          <label>${t("fire.expected_return")} (%)</label>
          <input id="fire-ret" type="number" min="-20" max="30" step="0.5" value="${expectedReturn}"/>
        </div>
        <div class="col field">
          <label>${t("fire.target_multiplier")}</label>
          <input id="fire-mul" type="number" min="10" max="50" step="1" value="${multiplier}"/>
        </div>
      </div>
    </div>

    <div style="height:14px"></div>

    <div class="summary-grid">
      <div class="summary-card">
        <div class="label">${t("fire.years_to_fire")}</div>
        <div class="value" style="color:${progressColor}">${yearsStr}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("fire.current_portfolio")}</div>
        <div class="value compact">${money(data.current_portfolio || 0)}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("fire.target_portfolio")}</div>
        <div class="value compact">${money(data.target_portfolio || 0)}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("fire.savings_rate")}</div>
        <div class="value" style="color:${(data.savings_rate_pct || 0) > 40 ? 'var(--success)' : 'var(--text)'}">${(data.savings_rate_pct || 0).toFixed(0)}%</div>
      </div>
    </div>

    <div style="height:14px"></div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <strong>${t("fire.progress_to_fire")}</strong>
        <span style="color:var(--text-muted);font-size:13px">${progress.toFixed(1)}%</span>
      </div>
      <div style="background:var(--border);border-radius:999px;height:14px;overflow:hidden">
        <div style="background:${progressColor};height:100%;width:${Math.min(100, progress)}%;transition:width 200ms ease"></div>
      </div>
    </div>

    <div style="height:14px"></div>

    <div class="card chart-card">
      <h3 style="margin-top:0">${t("fire.trajectory")}</h3>
      <div class="chart-canvas-wrap" style="height:300px"><canvas id="fire-chart"></canvas></div>
    </div>
  `;

  // Wire inputs (debounced auto-refresh)
  const debouncedRefresh = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => refresh(root), 400);
  };
  document.getElementById("fire-exp").oninput = (e) => { monthlyExpenses = parseFloat(e.target.value) || 0; debouncedRefresh(); };
  document.getElementById("fire-sav").oninput = (e) => { monthlySavings = parseFloat(e.target.value) || 0; debouncedRefresh(); };
  document.getElementById("fire-ret").oninput = (e) => { expectedReturn = parseFloat(e.target.value) || 0; debouncedRefresh(); };
  document.getElementById("fire-mul").oninput = (e) => { multiplier = parseFloat(e.target.value) || 25; debouncedRefresh(); };

  // Draw the trajectory chart
  if (data.trajectory && data.trajectory.length && window.Chart) {
    const ctx = document.getElementById("fire-chart");
    state.charts.fire = new window.Chart(ctx, {
      type: "line",
      data: {
        labels: data.trajectory.map(p => `Y${p.year}`),
        datasets: [
          {
            label: t("fire.portfolio_value"),
            data: data.trajectory.map(p => p.value),
            borderColor: "#8a7558",
            backgroundColor: "rgba(138, 117, 88, 0.08)",
            fill: true, tension: 0.2,
            pointRadius: 0,
            borderWidth: 1.5,
          },
          {
            label: t("fire.target"),
            data: data.trajectory.map(() => data.target_portfolio),
            borderColor: "#6b7d5e",
            borderWidth: 1.2,
            borderDash: [4, 4],
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: { y: { beginAtZero: true } },
      },
    });
  }
}
