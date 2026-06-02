// Asset comparator — pick 2 tickers + a window, get their price series
// from /market/historical and overlay them rebased to 100 on the first
// common date. Answers "which one would have been the better buy"
// directly. Drops the dead/aspirational compare.js that used to live
// here; this one is small, focused and only uses endpoints that exist.
import { API, loadChartJs, state, escapeHtml, spinner, toast, onViewCleanup } from "/static/app.js";

const PERIODS = ["1mo", "3mo", "6mo", "1y", "5y"];
let chart = null;

export async function render(root) {
  // Anti-rollback guard, same shape as the other views.
  let cancelled = false;
  onViewCleanup(() => { cancelled = true; if (chart) { try { chart.destroy(); } catch (_) {} chart = null; } });
  const myId = root.dataset.renderId;
  const stillOwns = () => !cancelled && root.dataset.renderId === myId;

  root.innerHTML = `
    <div class="card" style="padding:24px">
      <h3 style="margin:0 0 6px 0; font-family:var(--font-serif); font-weight:400; font-size:22px;">Compare two assets</h3>
      <p style="color:var(--text-muted); margin:0 0 18px; font-size:13px;">
        Both series rebase to <strong style="color:var(--text)">100</strong> on the first common date,
        so the chart shows return, not absolute price. Works for stocks, ETFs, indices, and crypto
        (BTC-USD / ETH-USD style or CoinGecko ids).
      </p>
      <div class="row">
        <div class="col field"><label>Asset A</label><input id="cmp-a" placeholder="MSFT" value="MSFT" autocomplete="off"/></div>
        <div class="col field"><label>Asset B</label><input id="cmp-b" placeholder="AAPL" value="AAPL" autocomplete="off"/></div>
        <div class="col field"><label>Window</label>
          <select id="cmp-p">${PERIODS.map(p => `<option value="${p}" ${p==="1y"?"selected":""}>${p.toUpperCase()}</option>`).join("")}</select>
        </div>
        <div class="col" style="display:flex; align-items:flex-end;">
          <button class="btn btn-primary" id="cmp-go" type="button" style="height:38px; width:100%;">Compare</button>
        </div>
      </div>
    </div>

    <div style="height:14px"></div>

    <div class="card" style="padding:18px">
      <div class="chart-canvas-wrap" style="height:340px"><canvas id="cmp-chart" role="img" aria-label="Comparison chart"></canvas></div>
      <div id="cmp-summary" style="margin-top:14px; color:var(--text-muted); font-size:13px;"></div>
    </div>
  `;

  const go = async () => {
    if (!stillOwns()) return;
    const a = (document.getElementById("cmp-a").value || "").trim();
    const b = (document.getElementById("cmp-b").value || "").trim();
    const period = document.getElementById("cmp-p").value;
    if (!a || !b) { toast("Pick two assets first.", "error"); return; }
    const sum = document.getElementById("cmp-summary");
    sum.innerHTML = `<span style="opacity:0.7">${spinner()} fetching ${escapeHtml(a)} vs ${escapeHtml(b)}…</span>`;

    let resA, resB;
    try {
      [resA, resB] = await Promise.all([
        API.request(`/market/historical/${encodeURIComponent(a)}?period=${period}`).catch((e) => ({ _err: e.message })),
        API.request(`/market/historical/${encodeURIComponent(b)}?period=${period}`).catch((e) => ({ _err: e.message })),
      ]);
    } catch (e) {
      if (!stillOwns()) return;
      sum.innerHTML = `<span style="color:var(--danger)">${escapeHtml(e.message)}</span>`;
      return;
    }
    if (!stillOwns()) return;

    if (resA?._err || resB?._err) {
      const which = resA?._err ? a : b;
      sum.innerHTML = `<span style="color:var(--danger)">No data for <strong>${escapeHtml(which)}</strong> (${escapeHtml(resA?._err || resB?._err)})</span>`;
      return;
    }

    // Intersect the two series on common dates so the rebase point is shared.
    const mapA = new Map((resA.candles || []).map(c => [c.date, c.close]));
    const mapB = new Map((resB.candles || []).map(c => [c.date, c.close]));
    const dates = [...mapA.keys()].filter(d => mapB.has(d)).sort();
    if (dates.length < 2) {
      sum.innerHTML = `<span style="color:var(--danger)">Not enough overlapping data between ${escapeHtml(a)} and ${escapeHtml(b)} for this window.</span>`;
      return;
    }
    const baseA = mapA.get(dates[0]) || 1;
    const baseB = mapB.get(dates[0]) || 1;
    const seriesA = dates.map(d => (mapA.get(d) / baseA) * 100);
    const seriesB = dates.map(d => (mapB.get(d) / baseB) * 100);

    const lastA = seriesA[seriesA.length - 1];
    const lastB = seriesB[seriesB.length - 1];
    const diff = lastA - lastB;
    const winner = diff >= 0 ? a : b;
    const winColor = diff >= 0 ? "var(--success)" : "var(--danger)";

    sum.innerHTML = `
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:14px;">
        <div><div style="font-family:var(--font-mono); font-size:10px; letter-spacing:0.18em; color:var(--text-muted); text-transform:uppercase;">${escapeHtml(a)}</div><div style="font-family:var(--font-serif); font-size:22px; color:#8a7558;">${(lastA - 100).toFixed(2)}%</div></div>
        <div><div style="font-family:var(--font-mono); font-size:10px; letter-spacing:0.18em; color:var(--text-muted); text-transform:uppercase;">${escapeHtml(b)}</div><div style="font-family:var(--font-serif); font-size:22px; color:#6b7d5e;">${(lastB - 100).toFixed(2)}%</div></div>
        <div><div style="font-family:var(--font-mono); font-size:10px; letter-spacing:0.18em; color:var(--text-muted); text-transform:uppercase;">Spread</div><div style="font-family:var(--font-serif); font-size:22px; color:${winColor};">${diff >= 0 ? "+" : ""}${diff.toFixed(2)} pts</div></div>
        <div><div style="font-family:var(--font-mono); font-size:10px; letter-spacing:0.18em; color:var(--text-muted); text-transform:uppercase;">Winner</div><div style="font-family:var(--font-serif); font-size:22px; color:${winColor};">${escapeHtml(winner)}</div></div>
      </div>
      <div style="margin-top:10px; font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">${dates.length} trading days · base 100 on ${escapeHtml(dates[0])}</div>
    `;

    await loadChartJs();
    if (!stillOwns()) return;
    const ctx = document.getElementById("cmp-chart");
    if (!ctx) return;
    if (chart) { try { chart.destroy(); } catch (_) {} }
    chart = new window.Chart(ctx, {
      type: "line",
      data: {
        labels: dates,
        datasets: [
          { label: a, data: seriesA, borderColor: "#8a7558", backgroundColor: "rgba(138,117,88,0.08)", borderWidth: 1.8, fill: false, tension: 0.25, pointRadius: 0, pointHoverRadius: 4 },
          { label: b, data: seriesB, borderColor: "#6b7d5e", backgroundColor: "rgba(107,125,94,0.08)", borderWidth: 1.8, fill: false, tension: 0.25, pointRadius: 0, pointHoverRadius: 4 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: "bottom", labels: { font: { size: 11 }, boxWidth: 14 } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(2)}` } },
        },
        scales: {
          y: { beginAtZero: false, title: { display: true, text: "Base 100", font: { size: 10 }, color: "var(--text-muted)" } },
        },
      },
    });
  };

  document.getElementById("cmp-go").onclick = go;
  // Fire once on load with the defaults so users see a populated view.
  go();
}
