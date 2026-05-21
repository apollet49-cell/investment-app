// "What if I had bought XYZ on the same date instead?" Side-by-side
// comparison of the user's actual investment against an alternative
// asset, using the same purchase date and amount. The backend does the
// price-on-date lookup; this just renders the result.
import { API, escapeHtml, money, pct, spinner } from "/static/app.js";
import { t } from "/static/i18n.js";

import { tableState } from "./state.js";
import { closeModal, injectModalStyles } from "./modal_shared.js";

const WHATIF_QUICK = [
  { symbol: "SPY", name: "S&P 500 (SPY)", asset_type: "etf" },
  { symbol: "QQQ", name: "NASDAQ-100 (QQQ)", asset_type: "etf" },
  { symbol: "BTC-USD", name: "Bitcoin", asset_type: "crypto" },
  { symbol: "ETH-USD", name: "Ethereum", asset_type: "crypto" },
  { symbol: "GLD", name: "Gold (GLD)", asset_type: "etf" },
  { symbol: "VWRL.L", name: "FTSE All-World", asset_type: "etf" },
];

let whatifSearchTimer = null;

export function openWhatIfModal(id) {
  const inv = tableState.cache.find(r => r.id === id);
  if (!inv) return;
  const host = document.getElementById("modal-host");
  host.innerHTML = `
    <div class="modal-overlay" id="whatif-overlay">
      <div class="modal-panel">
        <div class="modal-header">
          <strong>${t("investments.whatif.title")}: ${escapeHtml(inv.name)}</strong>
          <button class="icon-btn" id="whatif-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <p style="color:var(--text-muted);font-size:13px;margin:0 0 16px">
            ${t("investments.whatif.subtitle", { amount: money(inv.amount_invested), date: inv.purchase_date })}
          </p>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
            ${WHATIF_QUICK.map(q => `<button type="button" class="btn btn-ghost whatif-quick" data-symbol="${escapeHtml(q.symbol)}" data-type="${q.asset_type}" data-name="${escapeHtml(q.name)}">${escapeHtml(q.name)}</button>`).join("")}
          </div>
          <div class="field"><label>${t("investments.whatif.custom")}</label>
            <input id="whatif-search" placeholder="${t("investments.whatif.search_placeholder")}" autocomplete="off"/>
            <div id="whatif-results" class="asset-results"></div>
          </div>
          <div id="whatif-result" style="margin-top:14px"></div>
        </div>
      </div>
    </div>`;
  injectModalStyles();
  document.getElementById("whatif-close").onclick = closeModal;
  document.getElementById("whatif-overlay").onclick = (ev) => { if (ev.target.id === "whatif-overlay") closeModal(); };

  for (const b of document.querySelectorAll(".whatif-quick")) {
    b.onclick = () => runWhatIf(inv, { symbol: b.dataset.symbol, asset_type: b.dataset.type, name: b.dataset.name });
  }
  const search = document.getElementById("whatif-search");
  search.oninput = () => {
    clearTimeout(whatifSearchTimer);
    const q = search.value.trim();
    if (!q || q.length < 2) { document.getElementById("whatif-results").innerHTML = ""; return; }
    whatifSearchTimer = setTimeout(async () => {
      try {
        const data = await API.request(`/markets/search?q=${encodeURIComponent(q)}&limit=6`);
        const out = document.getElementById("whatif-results");
        if (!data.results?.length) { out.innerHTML = `<div class="asset-empty">No match</div>`; return; }
        out.innerHTML = data.results.map(r => `
          <button type="button" class="asset-row" data-symbol="${escapeHtml(r.symbol)}" data-name="${escapeHtml(r.name || r.symbol)}" data-type="${escapeHtml(r.type || "stock")}">
            <strong>${escapeHtml(r.symbol)}</strong>
            <span class="asset-name">${escapeHtml(r.name || "")}</span>
            <span class="badge gray">${escapeHtml(r.type || "stock")}</span>
          </button>`).join("");
        for (const row of out.querySelectorAll(".asset-row")) {
          row.onclick = () => runWhatIf(inv, {
            symbol: row.dataset.symbol,
            asset_type: (row.dataset.type || "stock").toLowerCase(),
            name: row.dataset.name,
          });
        }
      } catch (_) {}
    }, 250);
  };
}

async function runWhatIf(inv, alt) {
  const out = document.getElementById("whatif-result");
  out.innerHTML = `<div style="text-align:center;padding:20px">${spinner()} ${t("investments.whatif.simulating")}</div>`;
  try {
    const data = await API.request(`/investments/${inv.id}/what-if`, {
      method: "POST",
      body: { symbol: alt.symbol, asset_type: alt.asset_type },
    });
    const orig = data.original;
    const altR = data.alternative;
    const delta = data.delta;
    const deltaClass = delta.value >= 0 ? "text-success" : "text-danger";
    const deltaSign = delta.value >= 0 ? "+" : "−";
    out.innerHTML = `
      <div class="card" style="margin:0;padding:18px;background:var(--surface-2)">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">
          <div>
            <div class="label" style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted)">${t("investments.whatif.your_actual")}</div>
            <div style="font-family:var(--font-serif);font-size:22px">${escapeHtml(orig.name)}</div>
            <div style="margin-top:8px">${t("investments.whatif.current_value")}: <strong>${money(orig.current_value)}</strong></div>
            <div>${t("investments.whatif.gain")}: <strong class="${orig.gain >= 0 ? 'text-success' : 'text-danger'}">${orig.gain >= 0 ? "+" : ""}${money(orig.gain)} (${pct(orig.gain_pct)})</strong></div>
          </div>
          <div>
            <div class="label" style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted)">${t("investments.whatif.alternative")}</div>
            <div style="font-family:var(--font-serif);font-size:22px">${escapeHtml(alt.name)}</div>
            <div style="margin-top:8px">${t("investments.whatif.current_value")}: <strong>${money(altR.current_value)}</strong></div>
            <div>${t("investments.whatif.gain")}: <strong class="${altR.gain >= 0 ? 'text-success' : 'text-danger'}">${altR.gain >= 0 ? "+" : ""}${money(altR.gain)} (${pct(altR.gain_pct)})</strong></div>
          </div>
        </div>
        <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);text-align:center;font-size:14px">
          ${t("investments.whatif.delta")}:
          <strong class="${deltaClass}" style="font-family:var(--font-serif);font-size:22px;margin-left:6px">
            ${deltaSign}${money(Math.abs(delta.value))}
          </strong>
          <span style="color:var(--text-muted);font-size:12px;margin-left:6px">(${pct(delta.pct_points)} pts)</span>
        </div>
        <div style="color:var(--text-muted);font-size:11px;margin-top:6px;text-align:center">
          ${t("investments.whatif.basis", {
            qty: altR.implied_quantity.toLocaleString(undefined, { maximumFractionDigits: 6 }),
            buy_price: altR.purchase_price.toLocaleString(),
            date: altR.purchase_date_used,
          })}
        </div>
      </div>`;
  } catch (e) {
    out.innerHTML = `<div class="alert-banner error" style="margin:0">${escapeHtml(e.message)}</div>`;
  }
}
