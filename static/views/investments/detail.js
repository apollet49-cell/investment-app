// Detail modal for a row in the investments table. Routes to one of
// three renderers based on the asset's type: market (stock/ETF/crypto)
// shows a price-history Chart.js line + a news pane, real estate shows
// rental cashflow + DVF comparables, startup shows the projected value
// from the user-entered annual yield.
import { API, escapeHtml, loadChartJs, money, pct, spinner } from "/static/app.js";
import { t } from "/static/i18n.js";

import { tableState } from "./state.js";

let detailChart = null;

export async function openDetailModal(invId) {
  const inv = tableState.cache.find(r => r.id === invId);
  if (!inv) return;
  const host = document.getElementById("detail-modal-host");
  const roiClass = (inv.roi_pct || 0) >= 0 ? "var(--success)" : "var(--danger)";
  // pct() already emits the sign, so don't prepend another one.

  host.innerHTML = `
    <div class="modal-overlay" id="detail-overlay">
      <div class="modal-panel" style="max-width:900px">
        <div class="modal-header">
          <div>
            <strong style="font-family:var(--font-serif);font-size:20px">${escapeHtml(inv.name)}</strong>
            <div style="color:var(--text-muted);font-size:12px;margin-top:2px">
              ${t(`investments.types.${inv.type}`)}${inv.symbol ? ` · ${escapeHtml(inv.symbol)}` : ""}
              ${inv.city ? ` · ${escapeHtml(inv.city)} (${escapeHtml(inv.postal_code || "")})` : ""}
            </div>
          </div>
          <button class="icon-btn" id="detail-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <div class="summary-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:14px">
            <div class="summary-card"><div class="label">${t("investments.invested")}</div><div class="value" style="font-size:18px">${money(inv.amount_invested)}</div></div>
            <div class="summary-card"><div class="label">${t("investments.current")}</div><div class="value" style="font-size:18px">${money(inv.current_value)}</div></div>
            <div class="summary-card"><div class="label">${t("investments.roi")}</div><div class="value" style="font-size:18px;color:${roiClass}">${pct(inv.roi_pct)}</div></div>
            <div class="summary-card"><div class="label">${t("investments.purchase_date")}</div><div class="value" style="font-size:16px">${inv.purchase_date}</div></div>
          </div>
          <div id="detail-body"><div style="text-align:center;padding:24px">${spinner()}</div></div>
        </div>
      </div>
    </div>`;

  const close = () => {
    try { detailChart?.destroy?.(); } catch (_) {}
    detailChart = null;
    host.innerHTML = "";
  };
  document.getElementById("detail-close").onclick = close;
  document.getElementById("detail-overlay").onclick = (ev) => { if (ev.target.id === "detail-overlay") close(); };

  const body = document.getElementById("detail-body");

  if (inv.type === "real_estate") {
    await renderRealEstateDetail(body, inv);
  } else if (inv.symbol) {
    await renderMarketDetail(body, inv);
  } else if (inv.type === "startup") {
    renderStartupDetail(body, inv);
  } else {
    body.innerHTML = `<p style="color:var(--text-muted);text-align:center">${t("investments.detail_no_data")}</p>`;
  }
}

async function renderMarketDetail(body, inv) {
  body.innerHTML = `
    <div class="card chart-card" style="margin:0;padding:14px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h4 style="margin:0">${t("investments.detail_price_history")}</h4>
        <div id="detail-period-tabs" style="display:flex;gap:4px"></div>
      </div>
      <div class="chart-canvas-wrap" style="height:280px;margin-top:8px"><canvas id="detail-chart"></canvas></div>
    </div>
    <div style="height:12px"></div>
    <div id="detail-news" class="card" style="margin:0;padding:14px">
      <h4 style="margin:0 0 8px 0">${t("investments.detail_news")}</h4>
      <div id="detail-news-body" style="color:var(--text-muted);font-size:13px">${spinner()}</div>
    </div>
  `;

  const periods = ["1mo", "3mo", "6mo", "1y", "5y"];
  const tabs = document.getElementById("detail-period-tabs");
  tabs.innerHTML = periods.map(p => `<button class="btn btn-ghost detail-period" data-p="${p}" style="font-size:11px;padding:4px 8px">${p.toUpperCase()}</button>`).join("");
  const renderChart = async (period) => {
    for (const btn of tabs.querySelectorAll(".detail-period")) {
      btn.classList.toggle("btn-primary", btn.dataset.p === period);
      btn.classList.toggle("btn-ghost", btn.dataset.p !== period);
    }
    try {
      // /market/historical returns { symbol, period, candles: [{date,open,high,low,close,volume}] }
      // — the old /markets/asset endpoint (deleted with the markets browser
      // feature) returned the same shape but with `time` (unix seconds)
      // instead of `date`. Use date directly so we don't depend on the
      // dropped router.
      const data = await API.request(`/market/historical/${encodeURIComponent(inv.symbol)}?period=${period}`);
      const candles = data?.candles || [];
      const series = candles.map(c => ({ date: c.date || (c.time ? new Date(c.time * 1000).toISOString().slice(0, 10) : ""), close: c.close }));
      drawDetailChart(series, inv);
    } catch (e) {
      const ctx = document.getElementById("detail-chart")?.parentElement;
      if (ctx) ctx.innerHTML = `<div style="color:var(--text-muted);text-align:center;padding:30px">${t("investments.detail_chart_unavailable")}</div>`;
    }
  };
  for (const btn of tabs.querySelectorAll(".detail-period")) {
    btn.onclick = () => renderChart(btn.dataset.p);
  }
  await renderChart("1y");

  // News from Google News RSS. We pass the company name as the search
  // query when available — for MSFT that gives "Microsoft" results, way
  // more on-topic than searching the ticker. Falls back to the symbol
  // for crypto (where inv.name often matches inv.symbol).
  try {
    const query = inv.name || inv.symbol;
    const news = await API.request(
      `/market/news/${encodeURIComponent(inv.symbol)}?q=${encodeURIComponent(query)}`
    );
    const items = news?.items || [];
    const nbody = document.getElementById("detail-news-body");
    if (!items.length) { nbody.innerHTML = `<em>${t("investments.detail_no_news")}</em>`; return; }
    nbody.innerHTML = items.slice(0, 12).map(n => `
      <div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <a href="${escapeHtml(n.url || '#')}" target="_blank" rel="noopener" style="color:var(--text);font-weight:500;text-decoration:none;line-height:1.4;display:block">${escapeHtml(n.title || "—")}</a>
        <div style="color:var(--text-muted);font-size:11px;margin-top:4px;font-family:var(--font-mono,monospace)">${escapeHtml(n.publisher || "")} · ${escapeHtml((n.published_at || "").slice(0, 10))}</div>
      </div>`).join("");
  } catch (_) {
    const nbody = document.getElementById("detail-news-body");
    if (nbody) nbody.innerHTML = `<em>${t("investments.detail_no_news")}</em>`;
  }
}

async function drawDetailChart(series, inv) {
  const ctx = document.getElementById("detail-chart");
  if (!ctx) return;
  await loadChartJs();
  if (!document.getElementById("detail-chart")) return;
  try { detailChart?.destroy?.(); } catch (_) {}
  const labels = series.map(p => p.date || p.timestamp);
  const data = series.map(p => p.close ?? p.price ?? p.value);
  detailChart = new window.Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: inv.symbol,
        data,
        borderColor: "#8a7558",
        backgroundColor: "rgba(138,117,88,0.08)",
        borderWidth: 1.6, fill: true, tension: 0.25,
        pointRadius: 0, pointHoverRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: false } },
    },
  });
}

async function renderRealEstateDetail(body, inv) {
  const cityLabel = inv.city ? `${inv.city}${inv.postal_code ? " (" + inv.postal_code + ")" : ""}` : t("investments.detail_no_city");
  const rent = inv.monthly_rental_income || 0;
  const charges = inv.monthly_rental_charges || 0;
  const mort = inv.monthly_mortgage_payment || 0;
  const net = rent - charges - mort;
  const netColor = net >= 0 ? "var(--success)" : "var(--danger)";
  body.innerHTML = `
    <div class="card" style="margin:0;padding:14px">
      <h4 style="margin:0 0 10px 0">${t("investments.real_estate.title") || "Real estate"}</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:13px">
        <div><span style="color:var(--text-muted)">${t("investments.real_estate.address") || "Address"}:</span> <strong>${escapeHtml(inv.address || "—")}</strong></div>
        <div><span style="color:var(--text-muted)">${t("investments.real_estate.city") || "City"}:</span> <strong>${escapeHtml(cityLabel)}</strong></div>
        <div><span style="color:var(--text-muted)">${t("investments.real_estate.surface_sqm")}:</span> <strong>${inv.surface_sqm ? inv.surface_sqm + " m²" : "—"}</strong></div>
        <div><span style="color:var(--text-muted)">${t("investments.real_estate.property_subtype")}:</span> <strong>${escapeHtml(inv.property_subtype || "—")}</strong></div>
      </div>
      <div style="border-top:1px solid var(--border);margin:14px 0;padding-top:12px;font-size:13px">
        <div><span style="color:var(--text-muted)">${t("investments.real_estate.monthly_income")}:</span> <strong>${money(rent)}/mo</strong></div>
        <div><span style="color:var(--text-muted)">${t("investments.real_estate.monthly_charges")}:</span> <strong>${money(charges)}/mo</strong></div>
        ${mort > 0 ? `<div><span style="color:var(--text-muted)">${t("investments.real_estate.monthly_mortgage")}:</span> <strong>${money(mort)}/mo</strong></div>` : ""}
        <div style="margin-top:6px"><span style="color:var(--text-muted)">${t("investments.real_estate.net_monthly")}:</span> <strong style="color:${netColor}">${money(net)}</strong> · <span style="color:var(--text-muted)">${t("investments.real_estate.net_annual")}:</span> <strong style="color:${netColor}">${money(net * 12)}</strong></div>
      </div>
      <div id="dvf-host" style="margin-top:8px;color:var(--text-muted);font-size:13px">${spinner()} ${t("investments.detail_loading_comparables")}</div>
    </div>
  `;
  // Try DVF comparables if we have enough info (postal_code or city/country=FR)
  const dvfHost = document.getElementById("dvf-host");
  if (inv.country === "FR" && (inv.postal_code || inv.city) && inv.surface_sqm) {
    try {
      const data = await API.request("/investments/estimate-value", {
        method: "POST",
        body: {
          postal_code: inv.postal_code, city: inv.city, country: "FR",
          surface_sqm: inv.surface_sqm, property_subtype: inv.property_subtype || "apartment",
        },
      });
      const estValue = data?.estimated_value_usd ?? data?.estimated_value_local;
      if (estValue != null) {
        const delta = estValue - inv.current_value;
        const dc = delta >= 0 ? "var(--success)" : "var(--danger)";
        const ppsqm = data?.median_price_per_sqm_local;
        const ppsqmCurrency = data?.local_currency || "EUR";
        dvfHost.innerHTML = `
          <div style="font-weight:500;color:var(--text);margin-bottom:6px">${t("investments.detail_market_estimate")}</div>
          <div>${t("investments.detail_estimate_value")}: <strong>${money(estValue)}</strong>
            <span style="color:${dc};margin-left:8px">(${delta >= 0 ? "+" : ""}${money(delta)} ${t("investments.detail_vs_book")})</span></div>
          ${ppsqm ? `<div style="margin-top:4px;font-size:12px">${t("investments.detail_price_sqm")}: <strong>${ppsqm.toLocaleString()} ${ppsqmCurrency}/m²</strong> · ${data.comparable_count || 0} ${t("investments.detail_comparables")}</div>` : ""}
        `;
      } else {
        dvfHost.innerHTML = `<em>${t("investments.detail_no_comparables")}</em>`;
      }
    } catch (_) {
      dvfHost.innerHTML = `<em>${t("investments.detail_no_comparables")}</em>`;
    }
  } else {
    dvfHost.innerHTML = `<em>${t("investments.detail_no_comparables")}</em>`;
  }
}

function renderStartupDetail(body, inv) {
  const yieldPct = inv.annual_yield_pct;
  const years = (Date.now() - new Date(inv.purchase_date).getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  const projected = yieldPct ? inv.amount_invested * Math.pow(1 + yieldPct / 100, years) : null;
  body.innerHTML = `
    <div class="card" style="margin:0;padding:14px">
      <h4 style="margin:0 0 10px 0">${t("investments.types.startup")}</h4>
      <div style="font-size:13px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><span style="color:var(--text-muted)">${t("investments.purchase_date")}:</span> <strong>${inv.purchase_date}</strong></div>
        <div><span style="color:var(--text-muted)">${t("investments.detail_holding_years")}:</span> <strong>${years.toFixed(1)}</strong></div>
        ${yieldPct != null ? `<div><span style="color:var(--text-muted)">${t("investments.detail_expected_yield")}:</span> <strong>${yieldPct}%/yr</strong></div>` : ""}
        ${projected != null ? `<div><span style="color:var(--text-muted)">${t("investments.detail_projected_today")}:</span> <strong>${money(projected)}</strong></div>` : ""}
      </div>
      ${inv.notes ? `<div style="margin-top:14px;padding:10px;background:var(--surface);border-radius:6px;font-size:13px;color:var(--text-muted);font-style:italic">"${escapeHtml(inv.notes)}"</div>` : ""}
      <div style="margin-top:14px;font-size:12px;color:var(--text-muted)">${t("investments.detail_startup_disclaimer")}</div>
    </div>
  `;
}
