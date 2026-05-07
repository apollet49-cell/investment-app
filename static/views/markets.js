import { API, state, money, pct, spinner, toast, escapeHtml } from "/static/app.js";
import { t } from "/static/i18n.js";

let activeTab = "stocks";
let cache = { stocks: null, etfs: null, crypto: null };
let sortKey = { stocks: "market_cap", etfs: "volume", crypto: "market_cap" };
let sortDir = { stocks: -1, etfs: -1, crypto: -1 };
let filters = { stocks: { sector: "", country: "" }, etfs: { category: "", region: "" }, crypto: {} };
let refreshTimer = null;

const TABS = ["stocks", "crypto", "etfs", "movers", "screener"];
const REFRESH_MS = { stocks: 60000, etfs: 60000, crypto: 30000 };

export async function render(root) {
  root.innerHTML = `
    <div class="card" style="padding:0;overflow:hidden">
      <div class="markets-tabs" id="markets-tabs">
        ${TABS.map(t2 => `<button data-tab="${t2}" class="markets-tab ${t2 === activeTab ? "active" : ""}">${t(`markets.tabs.${t2}`)}</button>`).join("")}
      </div>
      <div id="markets-tab-body" style="padding:18px"></div>
    </div>
    <div id="market-detail-host"></div>
  `;
  injectStyles();
  for (const b of root.querySelectorAll(".markets-tab")) {
    b.onclick = () => switchTab(b.dataset.tab);
  }
  // Cross-link from /watchlist (or other views): if the previous view stashed
  // an open-detail intent in sessionStorage, consume it now and pop the modal.
  const intent = sessionStorage.getItem("openMarketAsset");
  if (intent) {
    sessionStorage.removeItem("openMarketAsset");
    try {
      const { symbol, assetType } = JSON.parse(intent);
      setTimeout(() => openDetail(symbol, assetType, assetType === "crypto" ? symbol : undefined), 80);
    } catch (_) {}
  }
  await loadActive();
}

function switchTab(tab) {
  if (tab === activeTab) return;
  activeTab = tab;
  for (const b of document.querySelectorAll(".markets-tab")) b.classList.toggle("active", b.dataset.tab === tab);
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  loadActive();
}

async function loadActive() {
  const body = document.getElementById("markets-tab-body");
  if (activeTab === "movers") return renderMovers(body);
  if (activeTab === "screener") return renderScreener(body);
  await loadAndRenderTable(body, activeTab);
  if (REFRESH_MS[activeTab]) {
    refreshTimer = setInterval(() => loadAndRenderTable(body, activeTab, /*silent*/ true), REFRESH_MS[activeTab]);
  }
}

async function loadAndRenderTable(body, kind, silent = false) {
  if (!silent) {
    body.innerHTML = `<div style="text-align:center;padding:60px">
      ${spinner(true)}<div style="margin-top:12px;color:var(--text-muted)">${t("markets.loading_universe", { n: kind === "stocks" ? 250 : kind === "etfs" ? 250 : 250 })}</div>
    </div>`;
  }
  try {
    const path = kind === "crypto" ? "/markets/crypto" : (kind === "etfs" ? "/markets/etfs" : "/markets/stocks");
    const data = await API.request(path);
    cache[kind] = data.items;
    renderTable(body, kind);
  } catch (err) {
    body.innerHTML = `<div class="alert-banner error">${err.message}</div>`;
  }
}

// ---------- Table renderer ----------
function renderTable(body, kind) {
  const items = cache[kind] || [];
  if (!items.length) {
    body.innerHTML = `<div class="empty-state"><h3>No data</h3><p>The market data source returned no rows. Try again in a moment.</p></div>`;
    return;
  }

  const f = filters[kind];
  let filtered = items.slice();
  if (kind === "stocks") {
    if (f.sector) filtered = filtered.filter(r => r.sector === f.sector);
    if (f.country) filtered = filtered.filter(r => r.country === f.country);
  } else if (kind === "etfs") {
    if (f.category) filtered = filtered.filter(r => r.category === f.category);
    if (f.region) filtered = filtered.filter(r => r.region === f.region);
  }

  const sk = sortKey[kind], sd = sortDir[kind];
  filtered.sort((a, b) => {
    const av = a[sk] ?? 0;
    const bv = b[sk] ?? 0;
    if (av === bv) return 0;
    return (av > bv ? 1 : -1) * sd;
  });

  body.innerHTML = `
    ${renderToolbar(kind, items)}
    <div class="table-wrap" style="max-height:65vh;overflow-y:auto">
      <table class="data markets-table">
        ${renderHeader(kind)}
        <tbody>
          ${filtered.slice(0, 500).map((r, i) => renderRow(r, i + 1, kind)).join("")}
        </tbody>
      </table>
    </div>
    <div style="margin-top:8px;color:var(--text-muted);font-size:12px">${filtered.length} ${t("markets.screener.results")}</div>
  `;

  // Wire interactions
  for (const th of body.querySelectorAll("th[data-sort]")) {
    th.onclick = () => {
      const k = th.dataset.sort;
      if (sortKey[kind] === k) sortDir[kind] = -sortDir[kind]; else { sortKey[kind] = k; sortDir[kind] = -1; }
      renderTable(body, kind);
    };
  }
  for (const tr of body.querySelectorAll("tr[data-symbol]")) {
    tr.onclick = () => openDetail(tr.dataset.symbol, tr.dataset.assetType, tr.dataset.id);
  }
  for (const sel of body.querySelectorAll("select[data-filter]")) {
    sel.onchange = () => {
      filters[kind][sel.dataset.filter] = sel.value;
      renderTable(body, kind);
    };
  }
  const refreshBtn = body.querySelector("#markets-refresh");
  if (refreshBtn) refreshBtn.onclick = () => loadAndRenderTable(body, kind);
}

function renderToolbar(kind, items) {
  if (kind === "crypto") {
    return `<div class="toolbar">
      <button class="btn btn-ghost" id="markets-refresh">↻ ${t("markets.refresh")}</button>
      <span style="color:var(--text-muted);font-size:12px">Auto-refresh ${REFRESH_MS[kind] / 1000}s</span>
    </div>`;
  }
  if (kind === "stocks") {
    const sectors = uniqueOf(items, "sector");
    const countries = uniqueOf(items, "country");
    return `<div class="toolbar">
      <select data-filter="sector"><option value="">${t("markets.filter.all")} — ${t("markets.filter.sector")}</option>${sectors.map(s => `<option ${filters.stocks.sector === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      <select data-filter="country"><option value="">${t("markets.filter.all")} — ${t("markets.filter.country")}</option>${countries.map(c => `<option ${filters.stocks.country === c ? "selected" : ""}>${c}</option>`).join("")}</select>
      <button class="btn btn-ghost" id="markets-refresh">↻ ${t("markets.refresh")}</button>
      <span style="color:var(--text-muted);font-size:12px">Auto-refresh ${REFRESH_MS[kind] / 1000}s</span>
    </div>`;
  }
  if (kind === "etfs") {
    const categories = uniqueOf(items, "category");
    const regions = uniqueOf(items, "region");
    return `<div class="toolbar">
      <select data-filter="category"><option value="">${t("markets.filter.all")} — ${t("markets.filter.category")}</option>${categories.map(s => `<option ${filters.etfs.category === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      <select data-filter="region"><option value="">${t("markets.filter.all")} — ${t("markets.filter.region")}</option>${regions.map(c => `<option ${filters.etfs.region === c ? "selected" : ""}>${c}</option>`).join("")}</select>
      <button class="btn btn-ghost" id="markets-refresh">↻ ${t("markets.refresh")}</button>
    </div>`;
  }
  return "";
}

function renderHeader(kind) {
  const sd = (k) => sortKey[kind] === k ? (sortDir[kind] === 1 ? " ↑" : " ↓") : "";
  if (kind === "crypto") {
    return `<thead><tr>
      <th>${t("markets.cols.rank")}</th>
      <th>${t("markets.cols.name")}</th>
      <th data-sort="price" style="text-align:right">${t("markets.cols.price")}${sd("price")}</th>
      <th data-sort="change_24h" style="text-align:right">${t("markets.cols.change_24h")}${sd("change_24h")}</th>
      <th data-sort="change_7d" style="text-align:right">${t("markets.cols.change_7d")}${sd("change_7d")}</th>
      <th data-sort="market_cap" style="text-align:right">${t("markets.cols.market_cap")}${sd("market_cap")}</th>
      <th data-sort="volume_24h" style="text-align:right">${t("markets.cols.volume")}${sd("volume_24h")}</th>
      <th>7d</th>
      <th data-sort="ath" style="text-align:right">${t("markets.cols.ath")}${sd("ath")}</th>
    </tr></thead>`;
  }
  if (kind === "stocks") {
    return `<thead><tr>
      <th>${t("markets.cols.rank")}</th>
      <th data-sort="symbol">${t("markets.cols.symbol")}${sd("symbol")}</th>
      <th data-sort="price" style="text-align:right">${t("markets.cols.price")}${sd("price")}</th>
      <th data-sort="change_pct" style="text-align:right">${t("markets.cols.change")}${sd("change_pct")}</th>
      <th data-sort="volume" style="text-align:right">${t("markets.cols.volume")}${sd("volume")}</th>
      <th data-sort="sector">${t("markets.cols.sector")}${sd("sector")}</th>
      <th data-sort="country">${t("markets.cols.country")}${sd("country")}</th>
    </tr></thead>`;
  }
  // etfs
  return `<thead><tr>
    <th>${t("markets.cols.rank")}</th>
    <th data-sort="symbol">${t("markets.cols.symbol")}${sd("symbol")}</th>
    <th data-sort="price" style="text-align:right">${t("markets.cols.price")}${sd("price")}</th>
    <th data-sort="change_pct" style="text-align:right">${t("markets.cols.change")}${sd("change_pct")}</th>
    <th data-sort="volume" style="text-align:right">${t("markets.cols.volume")}${sd("volume")}</th>
    <th data-sort="category">${t("markets.cols.category")}${sd("category")}</th>
    <th data-sort="region">${t("markets.cols.region")}${sd("region")}</th>
  </tr></thead>`;
}

function renderRow(r, idx, kind) {
  if (kind === "crypto") {
    const img = r.image_url ? `<img src="${r.image_url}" width="20" height="20" style="vertical-align:middle;border-radius:50%;margin-right:6px"/>` : "";
    const sparkId = `spark-${r.id}-${idx}`;
    setTimeout(() => drawSparkline(sparkId, r.sparkline_7d || []), 0);
    return `<tr data-symbol="${escapeHtml(r.id)}" data-asset-type="crypto" data-id="${escapeHtml(r.id)}" style="cursor:pointer">
      <td>${idx}</td>
      <td>${img}<strong>${escapeHtml(r.name || "")}</strong> <span style="color:var(--text-muted);font-size:11px">${escapeHtml(r.symbol || "")}</span></td>
      <td style="text-align:right">${fmtUsd(r.price)}</td>
      <td style="text-align:right" class="${changeClass(r.change_24h)}">${pct(r.change_24h)}</td>
      <td style="text-align:right" class="${changeClass(r.change_7d)}">${pct(r.change_7d)}</td>
      <td style="text-align:right">${fmtCompact(r.market_cap)}</td>
      <td style="text-align:right">${fmtCompact(r.volume_24h)}</td>
      <td><canvas id="${sparkId}" width="80" height="24"></canvas></td>
      <td style="text-align:right">${fmtUsd(r.ath)}</td>
    </tr>`;
  }
  // stock or etf
  return `<tr data-symbol="${escapeHtml(r.symbol)}" data-asset-type="${r.asset_type}" style="cursor:pointer">
    <td>${idx}</td>
    <td><strong>${escapeHtml(r.symbol)}</strong></td>
    <td style="text-align:right">${fmtUsd(r.price)}</td>
    <td style="text-align:right" class="${changeClass(r.change_pct)}">${pct(r.change_pct)}</td>
    <td style="text-align:right">${fmtCompact(r.volume)}</td>
    <td>${escapeHtml(r.sector || r.category || "—")}</td>
    <td>${escapeHtml(r.country || r.region || "—")}</td>
  </tr>`;
}

// ---------- Movers tab ----------
async function renderMovers(body) {
  body.innerHTML = `
    <div class="toolbar" id="movers-subtabs">
      <button class="btn btn-primary" data-mover="stock">Stocks</button>
      <button class="btn btn-ghost" data-mover="crypto">Crypto</button>
      <button class="btn btn-ghost" data-mover="etf">ETFs</button>
    </div>
    <div id="movers-content"></div>`;
  for (const b of body.querySelectorAll("[data-mover]")) {
    b.onclick = () => {
      for (const x of body.querySelectorAll("[data-mover]")) {
        x.classList.toggle("btn-primary", x === b);
        x.classList.toggle("btn-ghost", x !== b);
      }
      loadMovers(b.dataset.mover);
    };
  }
  loadMovers("stock");
}

async function loadMovers(assetType) {
  const host = document.getElementById("movers-content");
  host.innerHTML = `<div style="text-align:center;padding:30px">${spinner(true)}</div>`;
  try {
    const data = await API.request(`/markets/movers/${assetType}?n=10`);
    host.innerHTML = `
      <div class="movers-grid">
        ${moverColumn(t("markets.movers.gainers"), data.gainers, assetType, "green")}
        ${moverColumn(t("markets.movers.losers"), data.losers, assetType, "red")}
        ${moverColumn(t("markets.movers.most_active"), data.most_active, assetType, "blue", true)}
      </div>`;
    for (const card of host.querySelectorAll(".mover-card")) {
      card.onclick = () => openDetail(card.dataset.symbol, card.dataset.assetType);
    }
  } catch (e) { host.innerHTML = `<div class="alert-banner error">${e.message}</div>`; }
}

function moverColumn(title, items, assetType, color, showVolume = false) {
  return `<div class="card" style="margin:0">
    <h3 style="margin-top:0">${title}</h3>
    ${items.map(r => `
      <div class="mover-card" data-symbol="${escapeHtml(r.id || r.symbol)}" data-asset-type="${assetType}">
        <div>
          <strong>${escapeHtml(r.symbol || r.id)}</strong>
          <div style="color:var(--text-muted);font-size:11px">${escapeHtml(r.name || r.symbol || "")}</div>
        </div>
        <div style="text-align:right">
          <div class="badge ${color === "blue" ? "gray" : color}">${pct(r.change_pct ?? r.change_24h)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${showVolume ? `Vol: ${fmtCompact(r.volume ?? r.volume_24h)}` : fmtUsd(r.price)}</div>
        </div>
      </div>
    `).join("")}
  </div>`;
}

// ---------- Screener tab ----------
async function renderScreener(body) {
  body.innerHTML = `
    <div class="card">
      <div class="row">
        <div class="col field"><label>${t("markets.screener.asset_type")}</label>
          <select id="sc-type"><option value="stock">Stocks</option><option value="etf">ETFs</option><option value="crypto">Crypto</option></select>
        </div>
        <div class="col field"><label>Min ${t("markets.cols.price")}</label><input id="sc-pmin" type="number" step="any" placeholder="0"/></div>
        <div class="col field"><label>Max ${t("markets.cols.price")}</label><input id="sc-pmax" type="number" step="any" placeholder="∞"/></div>
        <div class="col field"><label>Min ${t("markets.cols.change")} %</label><input id="sc-cmin" type="number" step="0.1" placeholder="-∞"/></div>
        <div class="col field"><label>Max ${t("markets.cols.change")} %</label><input id="sc-cmax" type="number" step="0.1" placeholder="∞"/></div>
        <div class="col field"><label>${t("markets.screener.min_volume")}</label><input id="sc-vmin" type="number" step="any" placeholder="0"/></div>
      </div>
      <button class="btn btn-primary" id="sc-run">${t("markets.screener.run")}</button>
      <button class="btn btn-ghost" id="sc-ai" disabled>🤖 ${t("markets.screener.ai_analyze")}</button>
    </div>
    <div id="sc-results" style="margin-top:14px"></div>
  `;
  document.getElementById("sc-run").onclick = runScreener;
}

async function runScreener() {
  const kind = document.getElementById("sc-type").value;
  const pmin = parseFloat(document.getElementById("sc-pmin").value) || -Infinity;
  const pmax = parseFloat(document.getElementById("sc-pmax").value) || Infinity;
  const cmin = parseFloat(document.getElementById("sc-cmin").value);
  const cmax = parseFloat(document.getElementById("sc-cmax").value);
  const vmin = parseFloat(document.getElementById("sc-vmin").value) || 0;
  const out = document.getElementById("sc-results");
  out.innerHTML = `<div style="text-align:center;padding:30px">${spinner(true)}</div>`;

  // Use cached batch if available; otherwise fetch.
  let items = cache[kind === "stock" ? "stocks" : (kind === "etf" ? "etfs" : "crypto")];
  if (!items) {
    try {
      const path = kind === "crypto" ? "/markets/crypto" : (kind === "etf" ? "/markets/etfs" : "/markets/stocks");
      const data = await API.request(path);
      cache[kind === "stock" ? "stocks" : (kind === "etf" ? "etfs" : "crypto")] = data.items;
      items = data.items;
    } catch (e) { out.innerHTML = `<div class="alert-banner error">${e.message}</div>`; return; }
  }

  const filtered = items.filter(r => {
    const price = r.price;
    const change = kind === "crypto" ? r.change_24h : r.change_pct;
    const vol = kind === "crypto" ? r.volume_24h : r.volume;
    if (price == null || price < pmin || price > pmax) return false;
    if (!Number.isNaN(cmin) && (change == null || change < cmin)) return false;
    if (!Number.isNaN(cmax) && (change == null || change > cmax)) return false;
    if (vol != null && vol < vmin) return false;
    return true;
  }).slice(0, 200);

  if (!filtered.length) {
    out.innerHTML = `<div class="empty-state"><p>No assets match these filters.</p></div>`;
    return;
  }
  out.innerHTML = `
    <div class="card">
      <h3>${filtered.length} ${t("markets.screener.results")}</h3>
      <div class="table-wrap" style="max-height:60vh;overflow-y:auto">
        <table class="data markets-table">
          <thead><tr>
            <th>${t("markets.cols.symbol")}</th>
            <th>${t("markets.cols.name")}</th>
            <th style="text-align:right">${t("markets.cols.price")}</th>
            <th style="text-align:right">${t("markets.cols.change")}</th>
            <th style="text-align:right">${t("markets.cols.volume")}</th>
          </tr></thead>
          <tbody>
            ${filtered.map(r => {
              const change = kind === "crypto" ? r.change_24h : r.change_pct;
              const vol = kind === "crypto" ? r.volume_24h : r.volume;
              return `<tr style="cursor:pointer" data-symbol="${escapeHtml(r.id || r.symbol)}" data-asset-type="${kind}">
                <td><strong>${escapeHtml(r.symbol || r.id)}</strong></td>
                <td>${escapeHtml(r.name || r.symbol || "")}</td>
                <td style="text-align:right">${fmtUsd(r.price)}</td>
                <td style="text-align:right" class="${changeClass(change)}">${pct(change)}</td>
                <td style="text-align:right">${fmtCompact(vol)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
  for (const tr of out.querySelectorAll("tr[data-symbol]")) {
    tr.onclick = () => openDetail(tr.dataset.symbol, tr.dataset.assetType);
  }
  // Enable AI button to summarise the screener result set
  const aiBtn = document.getElementById("sc-ai");
  aiBtn.disabled = false;
  aiBtn.onclick = () => askAiAboutScreener(filtered, kind);
}

function askAiAboutScreener(filtered, kind) {
  const top = filtered.slice(0, 20).map(r => `${r.symbol || r.id} (${kind})`).join(", ");
  const message = `I just ran a screener on the ${kind} universe and got these results: ${top}. Briefly: which 3 of these would you investigate most carefully and why? Be specific with reasoning.`;
  // Open the floating chat panel and send the message
  document.getElementById("chat-fab").click();
  setTimeout(() => {
    const ta = document.getElementById("chat-panel-input");
    const form = document.getElementById("chat-panel-form");
    if (ta && form) {
      ta.value = message;
      form.dispatchEvent(new Event("submit"));
    }
  }, 200);
}

// ---------- Asset detail modal ----------
let currentDetail = null;
let activePeriod = "1y";

let detailEscHandler = null;

async function openDetail(symbol, assetType, id) {
  const host = document.getElementById("market-detail-host");
  host.innerHTML = `
    <div class="detail-overlay" id="detail-overlay">
      <div class="detail-panel" role="dialog" aria-modal="true">
        <div class="detail-header">
          <strong id="detail-title">${escapeHtml(symbol)}</strong>
          <button class="icon-btn" id="detail-close" aria-label="Close">✕</button>
        </div>
        <div class="detail-body" id="detail-body">
          <div style="text-align:center;padding:60px">${spinner(true)}</div>
        </div>
      </div>
    </div>`;
  document.getElementById("detail-close").onclick = closeDetail;
  document.getElementById("detail-overlay").onclick = (ev) => { if (ev.target.id === "detail-overlay") closeDetail(); };
  document.body.style.overflow = "hidden";  // scroll-lock
  detailEscHandler = (ev) => { if (ev.key === "Escape") closeDetail(); };
  document.addEventListener("keydown", detailEscHandler);
  await loadDetail(id || symbol, assetType, activePeriod);
}

function closeDetail() {
  document.getElementById("market-detail-host").innerHTML = "";
  document.body.style.overflow = "";
  if (detailEscHandler) {
    document.removeEventListener("keydown", detailEscHandler);
    detailEscHandler = null;
  }
  currentDetail = null;
}

async function loadDetail(symbol, assetType, period) {
  activePeriod = period;
  const body = document.getElementById("detail-body");
  body.innerHTML = `<div style="text-align:center;padding:60px">${spinner(true)}</div>`;
  try {
    const detail = await API.request(`/markets/asset/${encodeURIComponent(symbol)}?asset_type=${assetType}&period=${period}`);
    currentDetail = detail;
    renderDetailBody(detail, assetType);
  } catch (e) {
    body.innerHTML = `<div class="alert-banner error">${e.message}</div>`;
  }
}

function renderDetailBody(d, assetType) {
  const body = document.getElementById("detail-body");
  document.getElementById("detail-title").innerHTML =
    `${d.image_url ? `<img src="${d.image_url}" width="22" style="vertical-align:middle;border-radius:50%;margin-right:8px"/>` : ""}${escapeHtml(d.name || d.symbol)} <span style="color:var(--text-muted);font-size:13px">${escapeHtml(d.symbol)}${d.exchange ? " · " + escapeHtml(d.exchange) : ""}</span>`;

  const periods = ["1mo", "3mo", "6mo", "1y", "5y"];
  body.innerHTML = `
    <div class="detail-stats">
      ${stat(t("markets.cols.price"), fmtUsd(d.price))}
      ${stat(t("markets.cols.market_cap"), fmtCompact(d.market_cap))}
      ${stat("52W high", fmtUsd(d.week52_high))}
      ${stat("52W low", fmtUsd(d.week52_low))}
      ${d.expense_ratio ? stat(t("markets.cols.expense"), `${(d.expense_ratio * 100).toFixed(2)}%`) : ""}
      ${d.pe_ratio ? stat("P/E", d.pe_ratio.toFixed(2)) : ""}
      ${d.dividend_yield ? stat("Div yield", `${(d.dividend_yield * 100).toFixed(2)}%`) : ""}
      ${d.beta ? stat("Beta", d.beta.toFixed(2)) : ""}
    </div>

    <div class="toolbar" style="margin-top:12px">
      ${periods.map(p => `<button data-period="${p}" class="btn ${p === activePeriod ? "btn-primary" : "btn-ghost"}">${t(`markets.period.${p}`) || p.toUpperCase()}</button>`).join("")}
      <span style="flex:1"></span>
      <button class="btn btn-primary" id="detail-ai">🤖 ${t("markets.detail.ai_analyze")}</button>
      <button class="btn btn-ghost" id="detail-watch">★ ${t("markets.detail.add_to_watchlist")}</button>
      <button class="btn btn-ghost" id="detail-add">＋ ${t("markets.detail.add_to_portfolio")}</button>
    </div>

    <div id="detail-chart" style="height:340px;margin-top:8px"></div>

    <div style="display:flex;gap:14px;margin-top:8px;align-items:center;flex-wrap:wrap">
      <label><input type="checkbox" data-overlay="ma20" checked/> ${t("markets.detail.ma20")}</label>
      <label><input type="checkbox" data-overlay="ma50" checked/> ${t("markets.detail.ma50")}</label>
      <label><input type="checkbox" data-overlay="ma200"/> ${t("markets.detail.ma200")}</label>
    </div>
    <div id="detail-rsi-macd" style="margin-top:8px"></div>

    ${d.summary ? `<div class="card" style="margin-top:14px"><h3>${escapeHtml(d.name || d.symbol)}</h3><p style="color:var(--text-muted)">${escapeHtml(d.summary)}</p>${d.website ? `<a href="${d.website}" target="_blank" rel="noopener">${t("markets.detail.website")} →</a>` : ""}</div>` : ""}

    <div class="card" style="margin-top:14px">
      <h3>${t("markets.detail.news")}</h3>
      <div id="detail-news"><div style="text-align:center;padding:20px">${spinner()}</div></div>
    </div>
  `;

  for (const b of body.querySelectorAll("[data-period]")) {
    b.onclick = () => loadDetail(d.id || d.symbol, assetType, b.dataset.period);
  }
  document.getElementById("detail-add").onclick = () => addToPortfolio(d, assetType);
  document.getElementById("detail-ai").onclick = () => askAiAboutAsset(d);
  document.getElementById("detail-watch").onclick = () => addToWatchlist(d, assetType);
  for (const cb of body.querySelectorAll("input[data-overlay]")) {
    cb.onchange = () => drawDetailChart(d);
  }

  drawDetailChart(d);
  drawRsiMacd(d);
  loadAssetNews(d.symbol);
}

function stat(label, val) {
  return `<div class="detail-stat"><span class="label">${label}</span><span class="value">${val}</span></div>`;
}

function drawDetailChart(d) {
  const host = document.getElementById("detail-chart");
  if (!host || !window.LightweightCharts) {
    host.innerHTML = `<div class="alert-banner error">Lightweight Charts library not loaded.</div>`;
    return;
  }
  host.innerHTML = "";
  const isDark = state.theme === "dark";
  const chart = window.LightweightCharts.createChart(host, {
    height: 340,
    layout: { background: { color: isDark ? "#221d18" : "#ffffff" }, textColor: isDark ? "#ece2d0" : "#2a241e" },
    grid: { vertLines: { color: isDark ? "#312a22" : "#ebe3d3" }, horzLines: { color: isDark ? "#312a22" : "#ebe3d3" } },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: isDark ? "#312a22" : "#ebe3d3" },
    rightPriceScale: { borderVisible: false },
  });
  const candleSeries = chart.addCandlestickSeries({
    upColor: "#6b7d5e", downColor: "#a56551", borderUpColor: "#6b7d5e",
    borderDownColor: "#a56551", wickUpColor: "#6b7d5e", wickDownColor: "#a56551",
  });
  candleSeries.setData(d.candles);

  // Overlays — muted taupe palette so they don't visually fight the candles.
  for (const cb of document.querySelectorAll("input[data-overlay]")) {
    if (!cb.checked) continue;
    const arr = d.indicators?.[cb.dataset.overlay];
    if (!arr) continue;
    const lineSeries = chart.addLineSeries({
      color: { ma20: "#8a7558", ma50: "#9d7f8f", ma200: "#7a8b9a" }[cb.dataset.overlay],
      lineWidth: 1,
    });
    const lineData = d.candles.map((c, i) => ({ time: c.time, value: arr[i] })).filter(x => x.value != null);
    lineSeries.setData(lineData);
  }
  setTimeout(() => chart.timeScale().fitContent(), 0);
}

function drawRsiMacd(d) {
  const host = document.getElementById("detail-rsi-macd");
  if (!host) return;
  const rsi = (d.indicators?.rsi14 || []).filter(v => v != null);
  const macd = d.indicators?.macd || { macd: [], signal: [], histogram: [] };
  const lastRsi = rsi.length ? rsi[rsi.length - 1] : null;
  const lastMacd = macd.macd.filter(v => v != null).slice(-1)[0];
  const lastSig = macd.signal.filter(v => v != null).slice(-1)[0];
  const rsiBadge = lastRsi == null ? "—" : (lastRsi > 70 ? `<span class="badge red">${lastRsi.toFixed(1)} overbought</span>` : lastRsi < 30 ? `<span class="badge green">${lastRsi.toFixed(1)} oversold</span>` : `<span class="badge gray">${lastRsi.toFixed(1)} neutral</span>`);
  const macdBadge = (lastMacd != null && lastSig != null)
    ? (lastMacd > lastSig ? `<span class="badge green">bullish (${lastMacd.toFixed(2)} > ${lastSig.toFixed(2)})</span>` : `<span class="badge red">bearish (${lastMacd.toFixed(2)} ≤ ${lastSig.toFixed(2)})</span>`)
    : "—";
  host.innerHTML = `<div class="card" style="display:flex;gap:24px"><div><strong>${t("markets.detail.rsi")}:</strong> ${rsiBadge}</div><div><strong>${t("markets.detail.macd")}:</strong> ${macdBadge}</div></div>`;
}

async function loadAssetNews(symbol) {
  const host = document.getElementById("detail-news");
  try {
    const res = await API.request(`/markets/asset/${encodeURIComponent(symbol)}/news`);
    if (!res.items.length) { host.innerHTML = `<p style="color:var(--text-muted)">${t("markets.detail.no_news")}</p>`; return; }
    host.innerHTML = res.items.map(n => `
      <div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border)">
        <a href="${n.link}" target="_blank" rel="noopener"><strong>${escapeHtml(n.title)}</strong></a>
        <div style="color:var(--text-muted);font-size:11px;margin:2px 0">${n.published ? new Date(n.published).toLocaleString() : ""} · ${escapeHtml(n.source)}</div>
        <div style="color:var(--text-muted);font-size:13px">${escapeHtml(n.summary)}</div>
      </div>`).join("");
  } catch (e) { host.innerHTML = `<p style="color:var(--text-muted)">${e.message}</p>`; }
}

function askAiAboutAsset(d) {
  const message = t("markets.detail.ai_prompt", { symbol: d.symbol });
  document.getElementById("chat-fab").click();
  setTimeout(() => {
    const ta = document.getElementById("chat-panel-input");
    const form = document.getElementById("chat-panel-form");
    if (ta && form) { ta.value = message; form.dispatchEvent(new Event("submit")); }
  }, 200);
}

async function addToWatchlist(d, assetType) {
  try {
    await API.request("/watchlist/", {
      method: "POST",
      body: { symbol: d.symbol || d.id, asset_type: assetType, name: d.name || d.symbol },
    });
    toast(`${d.symbol || d.name} added to watchlist`, "success");
  } catch (e) { toast(e.message, "error"); }
}

function addToPortfolio(d, assetType) {
  // Stash a draft in sessionStorage and route to investments view; the
  // investments view does not yet read this — for now we use a confirm()
  // and call the API directly so the UX is one-shot.
  const ok = confirm(`Add ${d.symbol} to portfolio at current price ${fmtUsd(d.price)}?\n\nYou'll be able to edit the amount in the Investments tab.`);
  if (!ok) return;
  const today = new Date().toISOString().slice(0, 10);
  const typeMap = { crypto: "crypto", etf: "etf", stock: "stock" };
  const payload = {
    name: d.name || d.symbol,
    type: typeMap[assetType] || "stock",
    symbol: d.symbol,
    amount_invested: d.price || 1,
    current_value: d.price || 1,
    purchase_date: today,
    notes: `Added from market browser on ${today}`,
  };
  API.request("/investments/", { method: "POST", body: payload })
    .then(() => { toast(`Added ${d.symbol} to portfolio`, "success"); closeDetail(); })
    .catch(e => toast(e.message, "error"));
}

// ---------- Helpers ----------
function uniqueOf(items, key) {
  return Array.from(new Set(items.map(r => r[key]).filter(Boolean))).sort();
}
function fmtUsd(v) {
  if (v == null) return "—";
  if (v >= 1) return `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `$${Number(v).toFixed(6)}`;
}
function fmtCompact(v) {
  if (v == null) return "—";
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(v);
}
function changeClass(v) {
  if (v == null) return "";
  return v > 0 ? "text-success" : v < 0 ? "text-danger" : "";
}

function drawSparkline(canvasId, points) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !points.length) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((p - min) / span) * h;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  const trendUp = points[points.length - 1] >= points[0];
  ctx.strokeStyle = trendUp ? "#6b7d5e" : "#a56551";
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

// ---------- Inline styles (scoped to this view) ----------
function injectStyles() {
  if (document.getElementById("markets-styles")) return;
  const css = `
  .markets-tabs { display:flex; gap:0; border-bottom:1px solid var(--border); }
  .markets-tab { background:transparent; border:none; padding:14px 22px; cursor:pointer; color:var(--text-muted); font-size:14px; font-weight:600; border-bottom:3px solid transparent; }
  .markets-tab:hover { color:var(--text); }
  .markets-tab.active { color:var(--primary); border-bottom-color:var(--primary); }
  table.markets-table th { position:sticky; top:0; z-index:1; cursor:pointer; user-select:none; }
  table.markets-table tr:hover td { background:var(--surface-2); }
  .text-success { color:var(--success); }
  .text-danger  { color:var(--danger); }
  .movers-grid { display:grid; gap:14px; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); }
  .mover-card { display:flex; justify-content:space-between; align-items:center; padding:8px 4px; border-bottom:1px solid var(--border); cursor:pointer; }
  .mover-card:hover { background:var(--surface-2); }
  .detail-overlay { position:fixed; inset:0; background:rgba(15,23,42,0.6); z-index:1000; display:flex; justify-content:flex-end; }
  .detail-panel { width:min(900px, 96vw); height:100vh; background:var(--surface); display:flex; flex-direction:column; box-shadow:-10px 0 40px rgba(0,0,0,0.4); }
  .detail-header { display:flex; justify-content:space-between; align-items:center; padding:14px 22px; border-bottom:1px solid var(--border); background:var(--sidebar-bg); color:#fff; }
  .detail-header .icon-btn { color:#fff; border-color:rgba(255,255,255,0.2); }
  .detail-body { flex:1; overflow-y:auto; padding:18px 22px; }
  .detail-stats { display:grid; gap:10px; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); }
  .detail-stat { background:var(--surface-2); padding:10px 12px; border-radius:6px; }
  .detail-stat .label { display:block; color:var(--text-muted); font-size:11px; text-transform:uppercase; letter-spacing:0.4px; }
  .detail-stat .value { font-weight:700; font-size:16px; }
  `;
  const s = document.createElement("style");
  s.id = "markets-styles";
  s.textContent = css;
  document.head.appendChild(s);
}
