import { API, spinner, toast, escapeHtml } from "/static/app.js";
import { t } from "/static/i18n.js";

export async function render(root) {
  root.innerHTML = `<div class="card" style="text-align:center;padding:40px">${spinner(true)}</div>`;
  let items;
  try { items = (await API.request("/watchlist/live")).items; }
  catch (e) { root.innerHTML = `<div class="alert-banner error">${e.message}</div>`; return; }

  if (!items.length) {
    root.innerHTML = `
      <div class="card empty-state">
        <svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="3">
          <path d="M40 14 L48 32 L68 34 L52 48 L57 68 L40 58 L23 68 L28 48 L12 34 L32 32 Z"/>
        </svg>
        <h3>${t("watchlist.empty_title")}</h3>
        <p>${t("watchlist.empty_sub")}</p>
        <button class="btn btn-primary" id="wl-go-markets">${t("watchlist.browse_markets")}</button>
      </div>`;
    document.getElementById("wl-go-markets").onclick = () => location.hash = "#/markets";
    return;
  }

  root.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">${items.length} ${t("watchlist.items")}</h3>
      <div class="table-wrap">
        <table class="data">
          <thead><tr>
            <th>${t("watchlist.cols.name")}</th>
            <th>${t("watchlist.cols.type")}</th>
            <th style="text-align:right">${t("watchlist.cols.price")}</th>
            <th style="text-align:right">${t("watchlist.cols.change")}</th>
            <th>${t("watchlist.cols.actions")}</th>
          </tr></thead>
          <tbody>
            ${items.map(i => row(i)).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
  for (const btn of root.querySelectorAll(".wl-view")) {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      // Stash the open-detail intent and navigate to markets, where it's consumed on render.
      sessionStorage.setItem("openMarketAsset", JSON.stringify({ symbol: btn.dataset.symbol, assetType: btn.dataset.type }));
      location.hash = "#/markets";
    };
  }
  for (const btn of root.querySelectorAll(".wl-remove")) {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      try {
        await API.request(`/watchlist/${btn.dataset.id}`, { method: "DELETE" });
        toast(t("common.deleted"), "success");
        render(root);
      } catch (e) { toast(e.message, "error"); }
    };
  }
}

function row(i) {
  const change = i.change_pct;
  const cls = change == null ? "" : change >= 0 ? "text-success" : "text-danger";
  const sign = change == null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
  const img = i.image_url ? `<img src="${i.image_url}" width="20" height="20" style="vertical-align:middle;border-radius:50%;margin-right:6px"/>` : "";
  return `<tr>
    <td>${img}<strong>${escapeHtml(i.name || i.symbol)}</strong> <span style="color:var(--text-muted);font-size:11px">${escapeHtml(i.symbol)}</span></td>
    <td><span class="badge gray">${escapeHtml(i.asset_type)}</span></td>
    <td style="text-align:right">${i.price == null ? "—" : `$${Number(i.price).toLocaleString(undefined, { maximumFractionDigits: 4 })}`}</td>
    <td style="text-align:right" class="${cls}">${sign}</td>
    <td>
      <button class="btn btn-ghost wl-view" data-symbol="${escapeHtml(i.symbol)}" data-type="${escapeHtml(i.asset_type)}">${t("watchlist.view")}</button>
      <button class="btn btn-ghost wl-remove" data-id="${i.id}">🗑</button>
    </td>
  </tr>`;
}
