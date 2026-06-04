// Performance view — XIRR vs S&P, TWR vs S&P, Δ in basis points.
// Three clickable tabs that share the same underlying data (portfolio
// normalized series + benchmark normalized series + final XIRR/TWR
// numbers from /dashboard/performance, plus vol/Sharpe/maxDD from
// /dashboard/risk). The chart re-renders when the tab changes; the
// KPI strip below is stable.
//
// The design mirrors the Geist mockup: monospace labels, sage green
// portfolio line, dotted gray benchmark line, KPI tiles in a bottom
// strip with thin borders.
import {
  API, loadChartJs, escapeHtml, spinner, onViewCleanup,
} from "/static/app.js";

const TABS = [
  { id: "xirr",  label: "XIRR vs S&P",       desc: "Money-weighted annualised return — accounts for the size and timing of your cash flows." },
  { id: "twr",   label: "TWR vs S&P",         desc: "Time-weighted annualised return — neutralises cash flow timing so you can fairly compare to an index." },
  { id: "delta", label: "Δ in basis points",  desc: "Spread between your portfolio and the benchmark over time, in basis points (100 bps = 1 %)." },
];

let chart = null;
let state = { tab: "xirr", data: null };

export async function render(root) {
  let cancelled = false;
  onViewCleanup(() => {
    cancelled = true;
    if (chart) { try { chart.destroy(); } catch (_) {} chart = null; }
    state = { tab: "xirr", data: null };
  });
  const myId = root.dataset.renderId;
  const owns = () => !cancelled && root.dataset.renderId === myId;

  root.innerHTML = `
    <div class="card" style="padding:24px">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap;">
        <div>
          <h3 style="margin:0 0 6px 0; font-family:var(--font-serif); font-weight:400; font-size:22px;">Performance</h3>
          <p id="perf-desc" style="color:var(--text-muted); margin:0; font-size:13px; max-width:680px;">${TABS[0].desc}</p>
        </div>
      </div>
    </div>

    <div style="height:14px"></div>

    <div id="perf-chart-card" class="card" style="padding:0; position:relative; background:var(--bg, #08080a); border:1px solid var(--border, rgba(255,255,255,0.08)); border-radius:14px; overflow:hidden;">
      <!-- Tabs row -->
      <div style="display:flex; align-items:center; justify-content:space-between; padding:16px 20px 0; gap:12px; flex-wrap:wrap;">
        <div id="perf-tabs" role="tablist" style="display:inline-flex; gap:4px; background:rgba(255,255,255,0.03); padding:4px; border-radius:999px; border:1px solid var(--border, rgba(255,255,255,0.08));">
          ${TABS.map((t, i) => `
            <button type="button" role="tab" data-tab="${t.id}" aria-selected="${i===0 ? "true" : "false"}"
              class="perf-tab" style="
                background:${i===0 ? "rgba(255,255,255,0.06)" : "transparent"};
                color:${i===0 ? "var(--text, #f5f5f0)" : "var(--text-muted, #8c8c87)"};
                border:none; border-radius:999px;
                padding:7px 14px; cursor:pointer;
                font-family:var(--font-sans, Geist, system-ui); font-size:12px; font-weight:500;
                transition:background .15s ease, color .15s ease;
              ">${escapeHtml(t.label)}</button>
          `).join("")}
        </div>
        <div id="perf-window" style="font-family:var(--font-mono, 'Geist Mono', monospace); font-size:10px; letter-spacing:0.18em; color:var(--text-muted, #8c8c87); text-transform:uppercase;">— · TODAY</div>
      </div>

      <!-- Legend (rendered into the canvas wrap as an absolute overlay) -->
      <div style="position:relative; padding:8px 20px 20px;">
        <div id="perf-legend" style="position:absolute; right:32px; top:8px; display:flex; flex-direction:column; align-items:flex-end; gap:4px; font-family:var(--font-mono, 'Geist Mono', monospace); font-size:10px; letter-spacing:0.14em; text-transform:uppercase; pointer-events:none;"></div>
        <div class="chart-canvas-wrap" style="height:340px;">
          <canvas id="perf-chart" role="img" aria-label="Performance chart"></canvas>
        </div>
      </div>

      <!-- KPI strip -->
      <div id="perf-kpis" style="display:grid; grid-template-columns:repeat(6, 1fr); border-top:1px solid var(--border, rgba(255,255,255,0.08));">
        ${["XIRR","Δ VS S&P","VOLATILITY","SHARPE","MAX DD","DAYS TRACKED"].map((label, i) => `
          <div style="padding:18px 20px; ${i<5 ? "border-right:1px solid var(--border, rgba(255,255,255,0.08));" : ""}">
            <div style="font-family:var(--font-mono, 'Geist Mono', monospace); font-size:9px; letter-spacing:0.18em; color:var(--text-muted, #8c8c87); text-transform:uppercase;">${escapeHtml(label)}</div>
            <div data-kpi="${i}" style="font-family:var(--font-serif, 'Instrument Serif', Georgia, serif); font-weight:400; font-size:26px; line-height:1.1; margin-top:6px; color:var(--text, #f5f5f0);">—</div>
          </div>
        `).join("")}
      </div>
    </div>

    <div style="height:14px"></div>

    <div class="card" style="padding:18px">
      <p style="margin:0; color:var(--text-muted); font-size:13px; line-height:1.6;">
        <strong style="color:var(--text)">Why three lenses ?</strong>
        XIRR answers <em>"what's my actual money-weighted CAGR"</em> — the rate that makes my dated cash flows balance out.
        TWR answers <em>"how good were my <b>picks</b>, ignoring the timing of when I put money in"</em>.
        The Δ tab shows the alpha (or shortfall) versus the index, in basis points over time.
        Same data, three answers — that's why they're tabbed.
      </p>
    </div>
  `;

  // Window pill — shows the period covered
  const winEl = document.getElementById("perf-window");

  // Wire tab clicks
  const tabBtns = root.querySelectorAll(".perf-tab");
  tabBtns.forEach(btn => {
    btn.onmouseenter = () => { if (btn.getAttribute("aria-selected") !== "true") btn.style.background = "rgba(255,255,255,0.04)"; };
    btn.onmouseleave = () => { if (btn.getAttribute("aria-selected") !== "true") btn.style.background = "transparent"; };
    btn.onclick = () => {
      if (state.tab === btn.dataset.tab || !owns()) return;
      state.tab = btn.dataset.tab;
      tabBtns.forEach(b => {
        const active = b.dataset.tab === state.tab;
        b.setAttribute("aria-selected", active ? "true" : "false");
        b.style.background = active ? "rgba(255,255,255,0.06)" : "transparent";
        b.style.color = active ? "var(--text, #f5f5f0)" : "var(--text-muted, #8c8c87)";
      });
      const t = TABS.find(t => t.id === state.tab);
      document.getElementById("perf-desc").textContent = t.desc;
      if (state.data) renderChart(state.data);
    };
  });

  // Fetch the 3 data sources in parallel — performance (XIRR/TWR), risk
  // (vol/Sharpe/maxDD), and history (the actual time series). Each is
  // tolerant of partial failure: if one fails, the others still render.
  let perf = null, risk = null, hist = null;
  try {
    [perf, risk, hist] = await Promise.all([
      API.request("/dashboard/performance").catch(() => null),
      API.request("/dashboard/risk?days=1825").catch(() => null),
      API.request("/dashboard/history?days=1825&benchmark=%5EGSPC").catch(() => null),
    ]);
  } catch (e) {
    // Promise.all here will only reject on synchronous errors (our catches
    // turn rejections into null), but guard anyway.
  }
  if (!owns()) return;

  if (!hist || !hist.portfolio || !hist.portfolio.length) {
    document.getElementById("perf-chart-card").innerHTML = `
      <div style="padding:48px 20px; text-align:center;">
        <div style="font-family:var(--font-serif); font-size:20px; margin-bottom:8px;">No history yet</div>
        <div style="color:var(--text-muted); font-size:13px; max-width:420px; margin:0 auto;">
          Performance metrics need at least a few daily snapshots. Add some investments and check back tomorrow — snapshots run automatically every 6 h.
        </div>
      </div>`;
    return;
  }

  state.data = { perf, risk, hist };
  fillKPIs(state.data);
  // Window label
  if (hist.portfolio.length) {
    const first = new Date(hist.portfolio[0].date);
    winEl.textContent = `${first.getFullYear()} · TODAY`;
  }
  await loadChartJs();
  if (!owns()) return;
  renderChart(state.data);
}

// ─── chart rendering ─────────────────────────────────────────────────

function renderChart(data) {
  const { perf, risk, hist } = data;
  const pSeries = hist.portfolio || [];
  const bSeries = hist.benchmark || [];

  // Use the existing normalized fields (base = 100 at start) and convert
  // to cumulative-return % (i.e. subtract 100). That's what the screenshot
  // shows: "+30 %" labels, growing from 0 %.
  const labels = pSeries.map(p => p.date);
  const portCumPct = pSeries.map(p => (p.normalized || 100) - 100);

  // Align benchmark to portfolio dates — benchmark is rebased at its own
  // index 0 already.
  const benchByDate = new Map(bSeries.map(b => [b.date, b.normalized]));
  const benchCumPct = labels.map(d => {
    const v = benchByDate.get(d);
    return v != null ? v - 100 : null;
  });

  // Build datasets based on the active tab
  const ctx = document.getElementById("perf-chart");
  if (!ctx) return;
  if (chart) { try { chart.destroy(); } catch (_) {} }

  const SAGE = "#6b7d5e";
  const SAGE_LIGHT = "rgba(107,125,94,0.10)";
  const GRAY = "rgba(180,180,170,0.55)";
  const TAN = "#8a7558";
  const CLAY = "#a85a4e";

  let datasets, yTitle;

  if (state.tab === "delta") {
    // Δ in basis points = (portfolio_cum - benchmark_cum) * 100  (since 1% = 100 bps)
    const deltaBps = labels.map((_, i) => {
      if (portCumPct[i] == null || benchCumPct[i] == null) return null;
      return (portCumPct[i] - benchCumPct[i]) * 100;
    });
    const finalDelta = lastNonNull(deltaBps) || 0;
    const lineColor = finalDelta >= 0 ? SAGE : CLAY;
    datasets = [{
      label: "Δ vs S&P (bps)",
      data: deltaBps,
      borderColor: lineColor,
      backgroundColor: finalDelta >= 0 ? "rgba(107,125,94,0.10)" : "rgba(168,90,78,0.10)",
      borderWidth: 1.8,
      fill: { target: "origin", above: "rgba(107,125,94,0.10)", below: "rgba(168,90,78,0.10)" },
      tension: 0.25,
      pointRadius: 0,
      pointHoverRadius: 4,
      spanGaps: true,
    }];
    yTitle = "Basis points";
    renderLegend([
      { label: "PORTFOLIO − S&P", value: fmtBps(finalDelta), color: lineColor },
    ]);
  } else {
    // XIRR or TWR view — same chart, different headline number on the legend
    datasets = [
      {
        label: "Your portfolio",
        data: portCumPct,
        borderColor: SAGE,
        backgroundColor: SAGE_LIGHT,
        borderWidth: 2,
        fill: true,
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: 4,
      },
      {
        label: "S&P 500",
        data: benchCumPct,
        borderColor: GRAY,
        backgroundColor: "transparent",
        borderWidth: 1.4,
        borderDash: [4, 4],
        fill: false,
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: 4,
        spanGaps: true,
      },
    ];
    yTitle = "Cumulative return";

    // Legend numbers depend on tab
    const portMetric = state.tab === "xirr" ? (perf?.xirr_pct ?? null) : (perf?.twr_pct ?? null);
    const benchCagr = benchmarkCagr(bSeries);
    renderLegend([
      { label: "YOUR PORTFOLIO", value: portMetric != null ? `+${portMetric.toFixed(1)} %/yr` : "—", color: SAGE },
      { label: "S&P 500",        value: benchCagr != null ? `+${benchCagr.toFixed(1)} %/yr` : "—", color: GRAY },
    ]);
  }

  chart = new window.Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 220 },
      plugins: {
        legend: { display: false },  // we render our own
        tooltip: {
          mode: "index", intersect: false,
          callbacks: {
            label: (c) => {
              const v = c.parsed.y;
              if (v == null) return null;
              const suffix = state.tab === "delta" ? " bps" : " %";
              return `${c.dataset.label}: ${v >= 0 ? "+" : ""}${v.toFixed(2)}${suffix}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(255,255,255,0.04)", drawBorder: false },
          ticks: {
            maxTicksLimit: 6,
            color: "rgba(180,180,170,0.55)",
            font: { family: "'Geist Mono', monospace", size: 10 },
            callback: function (val, idx) {
              const lbl = this.getLabelForValue(val);
              if (!lbl) return "";
              // Show just the year on tick
              return lbl.slice(0, 4);
            },
          },
        },
        y: {
          grid: { color: "rgba(255,255,255,0.04)", drawBorder: false },
          ticks: {
            color: "rgba(180,180,170,0.55)",
            font: { family: "'Geist Mono', monospace", size: 10 },
            callback: (v) => {
              if (state.tab === "delta") {
                return (v >= 0 ? "+" : "") + Math.round(v) + " bps";
              }
              return (v >= 0 ? "+" : "") + v.toFixed(0) + " %";
            },
          },
        },
      },
    },
  });
}

function renderLegend(items) {
  const el = document.getElementById("perf-legend");
  if (!el) return;
  el.innerHTML = items.map(it => `
    <div style="display:flex; align-items:center; gap:8px;">
      <span style="color:rgba(180,180,170,0.7); font-weight:400;">${escapeHtml(it.label)}</span>
      <span style="color:${it.color}; font-family:var(--font-mono, 'Geist Mono', monospace); font-weight:500;">· ${escapeHtml(it.value)}</span>
    </div>
  `).join("");
}

// ─── KPI strip ──────────────────────────────────────────────────────

function fillKPIs(data) {
  const { perf, risk, hist } = data;
  const cells = document.querySelectorAll("[data-kpi]");
  if (cells.length < 6) return;

  const xirr = perf?.xirr_pct;
  const benchCagr = benchmarkCagr(hist?.benchmark || []);
  const delta = (xirr != null && benchCagr != null) ? (xirr - benchCagr) : null;
  const vol = risk?.volatility_pct;
  const sharpe = risk?.sharpe;
  const maxDD = risk?.max_drawdown_pct;
  const daysTracked = (hist?.portfolio || []).length;

  const fmtPct = (v, sign = false) => {
    if (v == null) return "—";
    const s = sign && v >= 0 ? "+" : "";
    return `${s}${v.toFixed(1)} %`;
  };
  const fmtPts = (v) => {
    if (v == null) return "—";
    const s = v >= 0 ? "+" : "";
    return `${s}${v.toFixed(1)} pts`;
  };

  setKPI(cells[0], fmtPct(xirr, true), xirr != null && xirr >= 0 ? "#6b7d5e" : "#a85a4e");
  setKPI(cells[1], fmtPts(delta),       delta != null && delta >= 0 ? "#6b7d5e" : "#a85a4e");
  setKPI(cells[2], fmtPct(vol));
  setKPI(cells[3], sharpe != null ? sharpe.toFixed(2) : "—");
  setKPI(cells[4], maxDD != null ? `−${maxDD.toFixed(1)} %` : "—", "#a85a4e");
  setKPI(cells[5], daysTracked > 0 ? daysTracked.toLocaleString("fr-FR").replace(/ /g, " ") : "—");
}

function setKPI(el, text, color) {
  el.textContent = text;
  if (color) el.style.color = color;
}

// ─── helpers ────────────────────────────────────────────────────────

function lastNonNull(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

function benchmarkCagr(bSeries) {
  if (!bSeries || bSeries.length < 2) return null;
  const first = bSeries[0];
  const last = bSeries[bSeries.length - 1];
  if (!first?.normalized || !last?.normalized) return null;
  const days = (new Date(last.date) - new Date(first.date)) / 86400000;
  if (days < 30) return null;
  const cagr = Math.pow(last.normalized / first.normalized, 365 / days) - 1;
  return cagr * 100;
}

function fmtBps(v) {
  if (v == null) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${Math.round(v)} bps`;
}
