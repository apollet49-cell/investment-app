// Chart.js wrappers for the dashboard. Three line/doughnut/bar charts
// plus the history overlay that lazily re-draws the portfolio chart
// with the real snapshot series + S&P 500 benchmark.
import { cachedGet, loadChartJs, state } from "/static/app.js";
import { t } from "/static/i18n.js";

// Muted earth-tone palette to match the beige / taupe theme.
export const TYPE_COLORS = {
  stock: "#8a7558",        // taupe
  real_estate: "#6b7d5e",  // sage
  crypto: "#b8945e",       // warm amber
  bond: "#7a8b9a",         // muted slate
  etf: "#9d7f8f",          // dusty mauve
  startup: "#a56551",      // terracotta
};

// For EUR users, convert each point with the FX rate that applied at that
// snapshot (stored as p.fx_to_eur on /dashboard/history rows). When the
// rate is missing — older snapshots, or the forex cache was cold — fall
// back to the live state.fxRate so the chart still renders something
// sensible. For USD / GBP / CHF users we just plot the USD value as-is;
// per-currency historical FX would need its own column.
export function displayValueAtSnapshot(p) {
  const cur = state.user?.currency || "USD";
  if (cur === "USD") return Number(p.value) || 0;
  if (cur === "EUR") {
    const rate = (typeof p.fx_to_eur === "number" && p.fx_to_eur > 0)
      ? p.fx_to_eur
      : (state.fxRate || 1);
    return (Number(p.value) || 0) * rate;
  }
  // GBP / CHF: no historical column yet — use the current rate everywhere.
  return (Number(p.value) || 0) * (state.fxRate || 1);
}

export async function buildPortfolioChart(points) {
  const ctx = document.getElementById("chart-portfolio");
  if (!ctx) return;
  await loadChartJs();
  if (!document.getElementById("chart-portfolio")) return; // user navigated away
  state.charts.portfolio = new window.Chart(ctx, {
    type: "line",
    data: {
      labels: points.map(p => p.date),
      datasets: [{
        label: t("dashboard.portfolio_over_time"),
        data: points.map(displayValueAtSnapshot),
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

export async function loadHistoryAndBenchmark(isCancelled) {
  let history;
  try {
    history = await cachedGet("/dashboard/history?days=365&benchmark=^GSPC");
  } catch (e) {
    return; // keep the interpolated chart already drawn
  }
  if (isCancelled()) return;
  if (!history?.portfolio?.length || history.portfolio.length < 2) return;

  // Re-draw the portfolio chart with the real snapshot series + S&P overlay.
  const ctx = document.getElementById("chart-portfolio");
  if (!ctx) return;
  await loadChartJs();
  if (!document.getElementById("chart-portfolio")) return; // navigated away
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

export async function buildAllocationChart(byType) {
  const ctx = document.getElementById("chart-allocation");
  if (!ctx) return;
  await loadChartJs();
  if (!document.getElementById("chart-allocation")) return;
  try { state.charts.allocation?.destroy?.(); } catch (_) {}
  // `rawLabels` keeps the raw type slug ("stock", "real_estate", …) for
  // the click→filter handler; `labels` is the translated display label.
  const rawLabels = Object.keys(byType);
  const data = Object.values(byType);
  ctx.style.cursor = "pointer";
  state.charts.allocation = new window.Chart(ctx, {
    type: "doughnut",
    data: {
      labels: rawLabels.map(l => t(`investments.types.${l}`)),
      datasets: [{
        data,
        backgroundColor: rawLabels.map(l => TYPE_COLORS[l] || "#a89683"),
        borderColor: "#faf7f2",
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: "65%",
      plugins: { legend: { position: "bottom", labels: { font: { size: 12 }, boxWidth: 10 } } },
      onHover: (event, elements) => {
        event.native.target.style.cursor = elements.length ? "pointer" : "default";
      },
      // Click on a slice → navigate to /#/investments with the slice's
      // asset type pre-selected as the filter. sessionStorage is the
      // hand-off because it's robust to hashchange + view module reload.
      onClick: (event, elements) => {
        if (!elements || !elements.length) return;
        const slug = rawLabels[elements[0].index];
        if (!slug) return;
        try { sessionStorage.setItem("inv:pendingTypeFilter", slug); } catch (_) {}
        location.hash = "#/investments";
      },
    },
  });
}

export async function buildMonthlyChart(rows) {
  const ctx = document.getElementById("chart-monthly");
  if (!ctx) return;
  await loadChartJs();
  if (!document.getElementById("chart-monthly")) return;
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
