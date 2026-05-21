// Investments view: the table of holdings plus the toolbar that opens
// the add / edit / what-if / detail modals. The actual modal contents
// live in ./investments/*.js — this file decides what shows up in the
// table and wires the buttons.
import { API, cachedGet, downloadAuth, escapeHtml, money, onViewCleanup, pct, skeleton, state } from "/static/app.js";
import { t } from "/static/i18n.js";

import { TYPES, badgeClass, tableState } from "./investments/state.js";
import { deleteInv, onCsvUpload } from "./investments/modal_shared.js";
import { openForm } from "./investments/form.js";
import { openWhatIfModal } from "./investments/whatif.js";
import { openDetailModal } from "./investments/detail.js";

export async function render(root) {
  // Two layers of cancellation, matching dashboard.js:
  //   - `cancelled` closure flipped synchronously by view-cleanup
  //   - root.dataset.route token, the DOM-attached source of truth
  //     renderRoute() mutates on every navigation. The `stillOwnsRoot()`
  //     check catches the race where an in-flight await resolves before
  //     the cleanup fires, which is what was painting investments-then-
  //     dashboard over the wrong view.
  // The cleanup MUST register before any await so the timing window
  // closes immediately on navigation, not after the first cachedGet.
  let cancelled = false;
  let refreshTimer = null;
  onViewCleanup(() => {
    cancelled = true;
    if (refreshTimer) clearInterval(refreshTimer);
  });
  const myRenderId = root.dataset.renderId;
  const stillOwnsRoot = () => !cancelled && root.dataset.renderId === myRenderId;

  // Stale-while-revalidate so the table appears instantly on every visit
  // after the first. Spinner only on the cold first paint.
  const cacheKey = `swr:${state.token?.slice(-12) || "anon"}:/investments/`;
  if (sessionStorage.getItem(cacheKey) === null) {
    if (!stillOwnsRoot()) return;
    root.innerHTML = skeleton("table");
  }
  // Cross-view filter handoff — when the user clicks a slice on the
  // dashboard allocation doughnut, dashboard.js writes the asset type
  // to sessionStorage and navigates here. Apply once + clear the flag.
  try {
    const pending = sessionStorage.getItem("inv:pendingTypeFilter");
    if (pending) {
      tableState.filterType = pending;
      sessionStorage.removeItem("inv:pendingTypeFilter");
    }
  } catch (_) {}
  try {
    tableState.cache = await cachedGet("/investments/", (fresh) => {
      if (!stillOwnsRoot()) return;
      tableState.cache = fresh;
      refresh(root);
    });
  } catch (err) {
    if (!stillOwnsRoot()) return;
    root.innerHTML = `<div class="alert-banner error">${escapeHtml(err.message)}</div>`;
    return;
  }
  if (!stillOwnsRoot()) return;

  root.innerHTML = `
    <div class="toolbar">
      <input id="inv-search" class="grow" placeholder="${t("investments.search_placeholder")}" value="${escapeHtml(tableState.filterText)}" />
      <select id="inv-type-filter" class="btn btn-ghost" style="cursor:pointer">
        <option value="all">${t("investments.filter_all_types")}</option>
        ${TYPES.map(typ => `<option value="${typ}" ${tableState.filterType === typ ? "selected" : ""}>${t(`investments.types.${typ}`)}</option>`).join("")}
      </select>
      <button class="btn btn-primary" id="btn-add">+ ${t("investments.add")}</button>
      <label class="btn btn-ghost" for="csv-input">${t("investments.import_csv")}</label>
      <input id="csv-input" type="file" accept=".csv" hidden />
      <button class="btn btn-ghost" id="btn-export-csv" type="button">${t("investments.export_csv")}</button>
    </div>
    <div class="card">
      ${tableState.cache.length ? renderTable(tableState.cache) : emptyState()}
    </div>
    <div id="modal-host"></div>
    <div id="detail-modal-host"></div>
  `;

  document.getElementById("btn-add").onclick = () => openForm(undefined, refresh);
  document.getElementById("csv-input").onchange = (ev) => onCsvUpload(ev, refresh);
  document.getElementById("inv-search").oninput = (e) => { tableState.filterText = e.target.value.toLowerCase(); refresh(root); };
  document.getElementById("inv-type-filter").onchange = (e) => { tableState.filterType = e.target.value; refresh(root); };
  document.getElementById("btn-export-csv").onclick = () => downloadAuth("/exports/csv");
  attachRowHandlers(root);

  // Auto-refresh every 60s so live market prices flow into the table
  // without a manual reload. stillOwnsRoot covers the case where the
  // interval fires after navigation but before the cleanup clears the
  // timer (rare but possible if a tab was throttled).
  refreshTimer = setInterval(async () => {
    if (!stillOwnsRoot()) return;
    try {
      const data = await API.request("/investments/");
      if (!stillOwnsRoot()) return;
      tableState.cache = data;
      refresh(root);
    } catch (_) { /* network blip — try again next tick */ }
  }, 60000);

  // ---------- Live price flashes (Robinhood-style) ----------
  // Register this user's symbols with the backend market_data watcher
  // (POSTing once kicks off the SSE broadcasts for those tickers).
  API.request("/market/portfolio-live").catch(() => {});

  // Listen for SSE price broadcasts. Each event carries an array of
  // {symbol, price, currency, ...}. We find the matching row(s) by
  // data-symbol attribute, recompute current_value = price × quantity,
  // and animate a green/red flash on the cell — fading back over 1.2s.
  const onPrices = (ev) => {
    const prices = ev.detail?.prices || [];
    for (const p of prices) {
      applyPriceUpdate(p);
    }
  };
  window.addEventListener("market:prices", onPrices);
  onViewCleanup(() => window.removeEventListener("market:prices", onPrices));
}

function applyPriceUpdate(p) {
  const sym = (p?.symbol || "").toUpperCase();
  if (!sym || !isFinite(p?.price)) return;
  const rows = document.querySelectorAll(`tr.inv-row[data-symbol="${cssEscape(sym)}"]`);
  if (!rows.length) return;
  for (const tr of rows) {
    const qty = parseFloat(tr.dataset.qty || "0");
    if (!qty) continue;
    const newValue = qty * p.price;
    const cell = tr.querySelector(".col-current");
    if (!cell) continue;
    const prevValue = parseFloat(cell.dataset.value || "0");
    // Skip imperceptible moves (rounding noise on stable prices).
    const eps = Math.max(prevValue * 0.0005, 0.01);
    if (Math.abs(newValue - prevValue) < eps) continue;
    cell.dataset.value = newValue;
    cell.innerHTML = `<strong>${money(newValue)}</strong>`;
    cell.classList.remove("flash-up", "flash-down");
    // Force reflow so the new class triggers the animation
    void cell.offsetWidth;
    cell.classList.add(newValue > prevValue ? "flash-up" : "flash-down");
    setTimeout(() => { cell.classList.remove("flash-up", "flash-down"); }, 1200);
  }
}

function cssEscape(s) {
  // Minimal escape for use inside an attribute selector — symbols like
  // VWCE.DE contain a period that would otherwise be parsed as a class
  // selector by querySelectorAll.
  return String(s).replace(/[.^$*+?(){}[\]\\|/"#&]/g, "\\$&");
}

function refresh(root) {
  const card = root.querySelector(".card");
  card.innerHTML = tableState.cache.length ? renderTable(tableState.cache) : emptyState();
  attachRowHandlers(root);
}

function attachRowHandlers(root) {
  for (const th of root.querySelectorAll("th[data-sort]")) {
    th.onclick = () => {
      const k = th.dataset.sort;
      if (tableState.sortKey === k) tableState.sortDir = -tableState.sortDir;
      else { tableState.sortKey = k; tableState.sortDir = 1; }
      refresh(root);
    };
  }
  for (const btn of root.querySelectorAll(".inv-edit")) btn.onclick = () => openForm(parseInt(btn.dataset.id, 10), refresh);
  for (const btn of root.querySelectorAll(".inv-delete")) btn.onclick = () => deleteInv(parseInt(btn.dataset.id, 10), root, refresh);
  for (const btn of root.querySelectorAll(".inv-whatif")) btn.onclick = () => openWhatIfModal(parseInt(btn.dataset.id, 10));
  for (const tr of root.querySelectorAll(".inv-row")) {
    tr.onclick = () => openDetailModal(parseInt(tr.dataset.id, 10));
  }
  const empty = root.querySelector("#empty-add"); if (empty) empty.onclick = () => openForm(undefined, refresh);
}

function renderTable(rows) {
  const filtered = rows
    .filter(r => tableState.filterType === "all" || r.type === tableState.filterType)
    .filter(r => !tableState.filterText || `${r.name} ${r.symbol || ""} ${r.city || ""}`.toLowerCase().includes(tableState.filterText));
  // Sort: numeric fields compared numerically (so 9 < 100), strings
  // case-insensitively, nulls always sort to the end regardless of direction.
  filtered.sort((a, b) => {
    const av = a[tableState.sortKey];
    const bv = b[tableState.sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * tableState.sortDir;
    return String(av).localeCompare(String(bv), undefined, { numeric: true }) * tableState.sortDir;
  });
  const tdir = (k) => tableState.sortKey === k ? (tableState.sortDir === 1 ? " ↑" : " ↓") : "";
  if (filtered.length === 0) {
    return `<div class="empty-state" style="padding:30px 14px"><p>${t("investments.no_match")}</p></div>`;
  }
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;color:var(--text-muted);font-size:12px">
      <span>${t("investments.row_count", { count: filtered.length, total: rows.length })}</span>
      <span style="font-style:italic">${t("investments.click_row_hint")}</span>
    </div>
    <div class="table-wrap inv-table-wrap">
      <table class="data inv-table">
        <thead>
          <tr>
            <th data-sort="name" class="col-name">${t("investments.name")}${tdir("name")}</th>
            <th data-sort="type" class="col-mobile-hidden">${t("investments.type")}${tdir("type")}</th>
            <th data-sort="symbol" class="col-mobile-hidden">${t("investments.symbol")}${tdir("symbol")}</th>
            <th data-sort="quantity" class="col-mobile-hidden" style="text-align:right">${t("investments.quantity")}${tdir("quantity")}</th>
            <th data-sort="amount_invested" class="col-mobile-hidden" style="text-align:right">${t("investments.invested")}${tdir("amount_invested")}</th>
            <th data-sort="current_value" class="col-current" style="text-align:right">${t("investments.current")}${tdir("current_value")}</th>
            <th data-sort="purchase_date" class="col-mobile-hidden">${t("investments.purchase_date")}${tdir("purchase_date")}</th>
            <th data-sort="roi_pct" class="col-roi" style="text-align:right">${t("investments.roi")}${tdir("roi_pct")}</th>
            <th class="col-actions">${t("investments.actions")}</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(r => `
            <tr class="inv-row" data-id="${r.id}" data-symbol="${escapeHtml((r.symbol || "").toUpperCase())}" data-qty="${r.quantity || 0}" style="cursor:pointer">
              <td class="col-name">
                <strong>${escapeHtml(r.name)}</strong>
                <div class="col-mobile-sub">${t(`investments.types.${r.type}`)}${r.symbol ? ` · ${escapeHtml(r.symbol)}` : (r.city ? ` · ${escapeHtml(r.city)}` : "")}</div>
              </td>
              <td class="col-mobile-hidden">${t(`investments.types.${r.type}`)}</td>
              <td class="col-mobile-hidden">${escapeHtml(r.symbol || (r.city || "—"))}</td>
              <td class="col-mobile-hidden" style="text-align:right">${r.quantity == null ? "—" : Number(r.quantity).toLocaleString(undefined, { maximumFractionDigits: 8 })}</td>
              <td class="col-mobile-hidden" style="text-align:right">${money(r.amount_invested)}</td>
              <td class="col-current" style="text-align:right" data-value="${r.current_value}">${money(r.current_value)}</td>
              <td class="col-mobile-hidden">${r.purchase_date}</td>
              <td class="col-roi" style="text-align:right"><span class="badge ${badgeClass(r.roi_pct)}">${pct(r.roi_pct)}</span></td>
              <td class="col-actions" onclick="event.stopPropagation()" style="white-space:nowrap">
                <button class="btn-icon inv-edit" data-id="${r.id}" title="${t("investments.edit")}" aria-label="${t("investments.edit")}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="btn-icon inv-whatif" data-id="${r.id}" title="${t("investments.whatif.title")}" aria-label="${t("investments.whatif.title")}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 3v6h6"/></svg>
                </button>
                <button class="btn-icon inv-delete" data-id="${r.id}" title="${t("investments.delete")}" aria-label="${t("investments.delete")}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                </button>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function emptyState() {
  return `
    <div class="empty-state">
      <svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="14" y="20" width="52" height="44" rx="4"/>
        <path d="M14 36 H66"/>
        <circle cx="22" cy="28" r="2" fill="currentColor"/>
      </svg>
      <h3>${t("investments.empty_title")}</h3>
      <p>${t("investments.empty_sub")}</p>
      <button id="empty-add" class="btn btn-primary">+ ${t("investments.add")}</button>
    </div>`;
}
