// Risk view — full-page risk dashboard built around the underwater
// (drawdown) chart. The dashboard summary already shows risk score in
// a card; this view goes deeper: equity curve, drawdown over time,
// individual component breakdown, plain-English explanation.
import { API, loadChartJs, escapeHtml, spinner, onViewCleanup } from "/static/app.js";

const WINDOWS = [
  { days: 90, label: "3M" },
  { days: 180, label: "6M" },
  { days: 365, label: "1Y" },
  { days: 730, label: "2Y" },
  { days: 1825, label: "5Y" },
];

let equityChart = null;
let ddChart = null;

export async function render(root) {
  let cancelled = false;
  onViewCleanup(() => {
    cancelled = true;
    [equityChart, ddChart].forEach(c => { if (c) { try { c.destroy(); } catch (_) {} } });
    equityChart = null; ddChart = null;
  });
  const myId = root.dataset.renderId;
  const owns = () => !cancelled && root.dataset.renderId === myId;

  root.innerHTML = `
    <div class="card" style="padding:24px">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap;">
        <div>
          <h3 style="margin:0 0 6px 0; font-family:var(--font-serif); font-weight:400; font-size:22px;">Risk profile</h3>
          <p style="color:var(--text-muted); margin:0; font-size:13px; max-width:680px;">
            Volatility, drawdowns and beta computed from your real daily snapshots.
            The underwater chart below shows how far below the all-time peak your portfolio
            has been at each point — a clearer picture than a single "max drawdown" number.
          </p>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          ${WINDOWS.map(w => `<button class="btn btn-ghost risk-win" data-days="${w.days}" style="padding:5px 12px; font-size:12px;">${w.label}</button>`).join("")}
        </div>
      </div>
    </div>

    <div style="height:14px"></div>

    <div id="risk-content">${spinner()} <span style="opacity:0.6">loading risk metrics…</span></div>
  `;

  const buttons = root.querySelectorAll(".risk-win");
  const setActive = (days) => {
    buttons.forEach(b => {
      const isActive = parseInt(b.dataset.days, 10) === days;
      b.style.background = isActive ? "var(--text)" : "transparent";
      b.style.color = isActive ? "var(--bg)" : "var(--text-muted)";
      b.style.borderColor = isActive ? "var(--text)" : "var(--border)";
    });
  };
  buttons.forEach(b => {
    b.onclick = () => { setActive(parseInt(b.dataset.days, 10)); load(parseInt(b.dataset.days, 10)); };
  });

  async function load(days) {
    if (!owns()) return;
    const content = document.getElementById("risk-content");
    content.innerHTML = `${spinner()} <span style="opacity:0.6">loading…</span>`;

    let data;
    try {
      data = await API.request(`/dashboard/risk?days=${days}&include_series=true`);
    } catch (e) {
      if (!owns()) return;
      content.innerHTML = `<div class="card" style="padding:24px;color:var(--danger);">${escapeHtml(e.message)}</div>`;
      return;
    }
    if (!owns()) return;

    if (data.score == null) {
      // Insufficient history fallback
      content.innerHTML = `
        <div class="card" style="padding:32px; text-align:center;">
          <div style="font-family:var(--font-serif); font-size:20px; margin-bottom:8px;">Not enough history yet</div>
          <div style="color:var(--text-muted); font-size:13px;">We need at least 30 daily snapshots to compute meaningful risk metrics.
            You have ${data.n_days || 0}. Check back in a few weeks.</div>
        </div>`;
      return;
    }

    const tierColor = data.tier === "low" ? "#6b7d5e" : data.tier === "medium" ? "#8a7558" : "#a85a4e";
    const fmt = (n, d=2) => (n == null ? "—" : Number(n).toFixed(d));

    content.innerHTML = `
      <div class="row" style="gap:14px;">
        <div class="col card" style="padding:20px; min-width:160px;">
          <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:0.18em; color:var(--text-muted); text-transform:uppercase;">Risk score</div>
          <div style="font-family:var(--font-serif); font-size:38px; color:${tierColor}; line-height:1.1;">${fmt(data.score, 0)}</div>
          <div style="font-family:var(--font-mono); font-size:11px; color:${tierColor}; text-transform:uppercase; letter-spacing:0.15em; margin-top:4px;">${data.tier}</div>
        </div>
        <div class="col card" style="padding:20px; min-width:160px;">
          <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:0.18em; color:var(--text-muted); text-transform:uppercase;">Volatility (ann.)</div>
          <div style="font-family:var(--font-serif); font-size:28px; color:var(--text);">${fmt(data.volatility_pct, 1)}%</div>
        </div>
        <div class="col card" style="padding:20px; min-width:160px;">
          <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:0.18em; color:var(--text-muted); text-transform:uppercase;">Max drawdown</div>
          <div style="font-family:var(--font-serif); font-size:28px; color:var(--danger);">−${fmt(data.max_drawdown_pct, 1)}%</div>
        </div>
        <div class="col card" style="padding:20px; min-width:160px;">
          <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:0.18em; color:var(--text-muted); text-transform:uppercase;">Sharpe</div>
          <div style="font-family:var(--font-serif); font-size:28px; color:var(--text);">${fmt(data.sharpe, 2)}</div>
        </div>
        <div class="col card" style="padding:20px; min-width:160px;">
          <div style="font-family:var(--font-mono); font-size:10px; letter-spacing:0.18em; color:var(--text-muted); text-transform:uppercase;">Beta vs ${escapeHtml(data.benchmark_symbol || "")}</div>
          <div style="font-family:var(--font-serif); font-size:28px; color:var(--text);">${fmt(data.beta, 2)}</div>
        </div>
      </div>

      <div style="height:14px"></div>

      <div class="card" style="padding:18px">
        <h4 style="margin:0 0 4px 0; font-family:var(--font-serif); font-weight:400; font-size:17px;">Equity curve</h4>
        <p style="color:var(--text-muted); font-size:12px; margin:0 0 12px;">Your total portfolio value over time. Peaks set the high-water mark used by the underwater chart below.</p>
        <div class="chart-canvas-wrap" style="height:240px"><canvas id="equity-chart" role="img" aria-label="Equity curve"></canvas></div>
      </div>

      <div style="height:14px"></div>

      <div class="card" style="padding:18px">
        <h4 style="margin:0 0 4px 0; font-family:var(--font-serif); font-weight:400; font-size:17px;">Underwater chart — drawdown over time</h4>
        <p style="color:var(--text-muted); font-size:12px; margin:0 0 12px;">
          Each point shows how far below the all-time peak you were on that day.
          Flat at 0 = at a new high. Deep dips = painful periods. The bottom of the curve = your max drawdown of <strong style="color:var(--danger)">−${fmt(data.max_drawdown_pct, 1)}%</strong>.
        </p>
        <div class="chart-canvas-wrap" style="height:260px"><canvas id="dd-chart" role="img" aria-label="Drawdown chart"></canvas></div>
      </div>

      <div style="height:14px"></div>

      <div class="card" style="padding:20px">
        <h4 style="margin:0 0 8px 0; font-family:var(--font-serif); font-weight:400; font-size:17px;">What this means</h4>
        <p style="font-size:13.5px; line-height:1.6; color:var(--text); margin:0;">
          ${narrative(data)}
        </p>
      </div>
    `;

    // Render charts
    await loadChartJs();
    if (!owns()) return;
    drawCharts(data.series || []);
  }

  setActive(180);
  load(180);
}

function narrative(d) {
  const tier = d.tier;
  const vol = d.volatility_pct;
  const dd = d.max_drawdown_pct;
  const beta = d.beta;
  const sharpe = d.sharpe;

  let s = "";
  if (tier === "low") {
    s += `Your portfolio sits in the <strong style="color:#6b7d5e">low-risk</strong> zone. `;
  } else if (tier === "medium") {
    s += `Your portfolio sits in the <strong style="color:#8a7558">medium-risk</strong> zone — typical of a diversified equity portfolio. `;
  } else {
    s += `Your portfolio sits in the <strong style="color:#a85a4e">high-risk</strong> zone. Make sure your time horizon and emotional tolerance can absorb the swings. `;
  }
  s += `Annualised volatility of <strong>${vol?.toFixed(1)}%</strong> means roughly <strong>±${vol?.toFixed(0)}%</strong> typical year-over-year swing. `;
  s += `Your worst peak-to-trough loss in this window was <strong style="color:var(--danger)">−${dd?.toFixed(1)}%</strong> — that's the depth of the underwater chart above. `;
  if (beta != null) {
    if (Math.abs(beta - 1) < 0.15) {
      s += `Beta near 1 (${beta.toFixed(2)}) means you move roughly in line with the broad market. `;
    } else if (beta > 1) {
      s += `Beta of ${beta.toFixed(2)} means you amplify market moves — when the index drops 1%, you tend to drop ${beta.toFixed(2)}%. `;
    } else if (beta > 0) {
      s += `Beta of ${beta.toFixed(2)} means you move with the market but dampened. `;
    } else {
      s += `Negative beta (${beta.toFixed(2)}) means you tend to move <em>against</em> the market — defensive exposure. `;
    }
  }
  if (sharpe != null) {
    if (sharpe > 1) s += `Sharpe of ${sharpe.toFixed(2)} is solid — you've been well-paid for the risk taken. `;
    else if (sharpe > 0.5) s += `Sharpe of ${sharpe.toFixed(2)} is acceptable. `;
    else if (sharpe > 0) s += `Sharpe of ${sharpe.toFixed(2)} is low — the returns haven't fully justified the volatility. `;
    else s += `Sharpe is negative — you've underperformed the risk-free rate after adjusting for volatility. `;
  }
  return s;
}

function drawCharts(series) {
  if (!series.length) return;
  const labels = series.map(p => p.date);
  const values = series.map(p => p.value);
  const dds = series.map(p => p.drawdown_pct);

  const equityCanvas = document.getElementById("equity-chart");
  if (equityCanvas) {
    if (equityChart) { try { equityChart.destroy(); } catch (_) {} }
    equityChart = new window.Chart(equityCanvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Portfolio value",
          data: values,
          borderColor: "#6b7d5e",
          backgroundColor: "rgba(107,125,94,0.12)",
          borderWidth: 1.8, fill: true, tension: 0.25,
          pointRadius: 0, pointHoverRadius: 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => "$" + (c.parsed.y || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) } } },
        scales: {
          x: { ticks: { maxTicksLimit: 6, font: { size: 10 } } },
          y: { ticks: { font: { size: 10 }, callback: (v) => "$" + (v / 1000).toFixed(0) + "k" } },
        },
      },
    });
  }

  const ddCanvas = document.getElementById("dd-chart");
  if (ddCanvas) {
    if (ddChart) { try { ddChart.destroy(); } catch (_) {} }
    ddChart = new window.Chart(ddCanvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Drawdown",
          data: dds,
          borderColor: "#a85a4e",
          backgroundColor: "rgba(168,90,78,0.22)",
          borderWidth: 1.6, fill: true, tension: 0.15,
          pointRadius: 0, pointHoverRadius: 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.parsed.y.toFixed(2) + "%" } } },
        scales: {
          x: { ticks: { maxTicksLimit: 6, font: { size: 10 } } },
          y: { max: 0, ticks: { font: { size: 10 }, callback: (v) => v.toFixed(0) + "%" } },
        },
      },
    });
  }
}
