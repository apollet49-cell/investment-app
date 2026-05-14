import { API, state, pct, spinner, toast, escapeHtml, onViewCleanup } from "/static/app.js";
import { t } from "/static/i18n.js";

const PERIODS = ["1mo", "3mo", "6mo", "1y", "5y"];
let picked = [];   // [{ symbol, name, asset_type }]
let period = "1y";
let searchTimer = null;

const SERIES_COLORS = ["#8a7558", "#6b7d5e", "#9d7f8f", "#7a8b9a", "#a56551"];

export async function render(root) {
  for (const k of Object.keys(state.charts)) {
    try { state.charts[k]?.destroy?.(); } catch (_) {}
    delete state.charts[k];
  }
  root.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">${t("compare.title")}</h3>
      <p style="color:var(--text-muted);font-size:13px;margin:0 0 16px">${t("compare.subtitle")}</p>

      <div class="toolbar" style="margin-bottom:14px">
        <input id="compare-search" class="grow" placeholder="${t("compare.search_placeholder")}" autocomplete="off"/>
        <span style="flex:0 0 auto;display:flex;gap:4px">
          ${PERIODS.map(p => `<button class="btn ${p === period ? "btn-primary" : "btn-ghost"}" data-period="${p}">${p.toUpperCase()}</button>`).join("")}
        </span>
      </div>
      <div id="compare-results" class="asset-results" style="margin-bottom:10px"></div>
      <div id="compare-chips" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px"></div>

      <div class="chart-canvas-wrap" style="height:380px"><canvas id="compare-chart"></canvas></div>
      <div id="compare-table" style="margin-top:14px"></div>
    </div>
  `;
  injectStyles();
  document.getElementById("compare-search").oninput = (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (!q || q.length < 2) { document.getElementById("compare-results").innerHTML = ""; return; }
    searchTimer = setTimeout(() => doSearch(q), 250);
  };
  for (const b of root.querySelectorAll("[data-period]")) {
    b.onclick = () => {
      period = b.dataset.period;
      renderToolbarButtons(root);
      runCompare();
    };
  }
  renderChips();
  if (picked.length >= 1) runCompare();
}

function renderToolbarButtons(root) {
  for (const b of root.querySelectorAll("[data-period]")) {
    b.classList.toggle("btn-primary", b.dataset.period === period);
    b.classList.toggle("btn-ghost", b.dataset.period !== period);
  }
}

async function doSearch(q) {
  const out = document.getElementById("compare-results");
  out.innerHTML = `<div class="asset-loading">${spinner()}</div>`;
  try {
    const data = await API.request(`/markets/search?q=${encodeURIComponent(q)}&limit=6`);
    if (!data.results?.length) { out.innerHTML = `<div class="asset-empty">No match</div>`; return; }
    out.innerHTML = data.results.map(r => `
      <button type="button" class="asset-row" data-symbol="${escapeHtml(r.symbol)}" data-name="${escapeHtml(r.name || r.symbol)}" data-type="${escapeHtml(r.type || "stock")}">
        <strong>${escapeHtml(r.symbol)}</strong>
        <span class="asset-name">${escapeHtml(r.name || "")}</span>
        <span class="badge gray">${escapeHtml(r.type || "stock")}</span>
      </button>`).join("");
    for (const row of out.querySelectorAll(".asset-row")) row.onclick = () => addPick(row);
  } catch (e) { out.innerHTML = `<div class="asset-empty">${escapeHtml(e.message)}</div>`; }
}

function addPick(row) {
  if (picked.length >= 5) { toast("Max 5 assets to compare", "error"); return; }
  const sym = row.dataset.symbol;
  if (picked.some(p => p.symbol === sym)) return;
  picked.push({
    symbol: sym,
    name: row.dataset.name,
    asset_type: (row.dataset.type || "stock").toLowerCase(),
  });
  document.getElementById("compare-search").value = "";
  document.getElementById("compare-results").innerHTML = "";
  renderChips();
  runCompare();
}

function renderChips() {
  const host = document.getElementById("compare-chips");
  if (!host) return;
  host.innerHTML = picked.map((p, i) => `
    <span class="compare-chip" style="border-color:${SERIES_COLORS[i % SERIES_COLORS.length]}">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${SERIES_COLORS[i % SERIES_COLORS.length]}"></span>
      <strong>${escapeHtml(p.symbol)}</strong>
      <span style="color:var(--text-muted);font-size:11px">${escapeHtml(p.name)}</span>
      <button class="chip-x" data-idx="${i}">×</button>
    </span>`).join("");
  for (const x of host.querySelectorAll(".chip-x")) {
    x.onclick = () => { picked.splice(parseInt(x.dataset.idx, 10), 1); renderChips(); runCompare(); };
  }
}

async function runCompare() {
  const chartCtx = document.getElementById("compare-chart");
  const tableHost = document.getElementById("compare-table");
  if (!chartCtx) return;
  if (!picked.length) {
    if (state.charts.compare) { try { state.charts.compare.destroy(); } catch (_) {} delete state.charts.compare; }
    tableHost.innerHTML = `<div class="empty-state" style="padding:30px"><p>${t("compare.empty")}</p></div>`;
    return;
  }
  tableHost.innerHTML = `<div style="text-align:center;padding:20px">${spinner()}</div>`;
  try {
    const data = await API.request("/markets/compare", {
      method: "POST",
      body: { items: picked, period },
    });
    drawChart(data.series);
    renderTable(data.series);
  } catch (e) {
    tableHost.innerHTML = `<div class="alert-banner error">${escapeHtml(e.message)}</div>`;
  }
}

function drawChart(series) {
  const ctx = document.getElementById("compare-chart");
  if (state.charts.compare) { try { state.charts.compare.destroy(); } catch (_) {} }
  // Use the date axis from the longest series for the labels (every series is
  // normalised to base 100 so we don't need a shared x — just plot each in its
  // own dataset with point-by-point labels).
  const longest = series.reduce((acc, s) => (s.points?.length > acc.length ? s.points : acc), []);
  state.charts.compare = new window.Chart(ctx, {
    type: "line",
    data: {
      labels: longest.map(p => p.date),
      datasets: series.filter(s => s.points).map((s, i) => ({
        label: `${s.symbol}`,
        data: s.points.map(p => ({ x: p.date, y: p.value })),
        borderColor: SERIES_COLORS[i % SERIES_COLORS.length],
        backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length] + "20",
        borderWidth: 1.5,
        tension: 0.2,
        pointRadius: 0,
        pointHoverRadius: 4,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      plugins: {
        legend: { display: true, position: "bottom" },
        tooltip: { mode: "index", intersect: false },
      },
      scales: {
        x: { type: "category", ticks: { maxTicksLimit: 8 } },
        y: {
          title: { display: true, text: t("compare.base_100") },
          beginAtZero: false,
        },
      },
    },
  });
}

function renderTable(series) {
  const tableHost = document.getElementById("compare-table");
  if (!series.length) { tableHost.innerHTML = ""; return; }
  tableHost.innerHTML = `
    <div class="table-wrap"><table class="data">
      <thead><tr>
        <th>${t("compare.cols.asset")}</th>
        <th style="text-align:right">${t("compare.cols.start_price")}</th>
        <th style="text-align:right">${t("compare.cols.end_price")}</th>
        <th style="text-align:right">${t("compare.cols.change")}</th>
      </tr></thead>
      <tbody>
        ${series.map(s => {
          if (s.error) return `<tr><td><strong>${escapeHtml(s.symbol)}</strong></td><td colspan="3" style="color:var(--text-muted)">${escapeHtml(s.error)}</td></tr>`;
          const cls = s.change_pct >= 0 ? "text-success" : "text-danger";
          return `<tr>
            <td><strong>${escapeHtml(s.symbol)}</strong> <span style="color:var(--text-muted);font-size:11px">${escapeHtml(s.name)}</span></td>
            <td style="text-align:right">$${Number(s.start_price).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
            <td style="text-align:right">$${Number(s.end_price).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
            <td style="text-align:right" class="${cls}">${pct(s.change_pct)}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table></div>`;
}

function injectStyles() {
  if (document.getElementById("compare-styles")) return;
  const css = `
  .compare-chip {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--surface); border: 1px solid var(--border-strong);
    border-left-width: 3px; border-radius: 999px; padding: 4px 10px;
    font-size: 12px;
  }
  .compare-chip .chip-x {
    background: transparent; border: none; cursor: pointer;
    color: var(--text-muted); font-size: 14px; padding: 0 0 0 4px;
  }
  .compare-chip .chip-x:hover { color: var(--danger); }
  .text-success { color: var(--success); }
  .text-danger  { color: var(--danger); }
  `;
  const s = document.createElement("style");
  s.id = "compare-styles";
  s.textContent = css;
  document.head.appendChild(s);
}
