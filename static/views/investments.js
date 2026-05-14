import { API, money, pct, spinner, toast, escapeHtml } from "/static/app.js";
import { t } from "/static/i18n.js";

const TYPES = ["stock", "real_estate", "crypto", "bond", "etf", "startup"];
const UNIT_CAPABLE_TYPES = new Set(["stock", "etf", "crypto"]);

let cache = [];
let filterText = "";
let sortKey = "created_at";
let sortDir = -1;
// The asset most recently picked from the catalogue, used to refresh the
// historical purchase price when the user changes the purchase date.
let pickedAsset = null;     // { id, symbol, type }
let histPriceTimer = null;
// USD per unit *right now* and *on the purchase date*. Both are needed to
// translate "invested $X on date Y" into a current portfolio value.
let currentLivePrice = null;
let historicalPrice = null;

export async function render(root) {
  root.innerHTML = `<div style="text-align:center;padding:40px">${spinner(true)}</div>`;
  try { cache = await API.request("/investments/"); }
  catch (err) { root.innerHTML = `<div class="alert-banner error">${err.message}</div>`; return; }

  root.innerHTML = `
    <div class="toolbar">
      <input id="inv-search" class="grow" placeholder="${t("investments.search_placeholder")}" />
      <button class="btn btn-primary" id="btn-add">+ ${t("investments.add")}</button>
      <button class="btn btn-ghost" id="btn-wallet">${t("investments.connect_wallet")}</button>
      <label class="btn btn-ghost" for="csv-input">${t("investments.import_csv")}</label>
      <input id="csv-input" type="file" accept=".csv" hidden />
      <a class="btn btn-ghost" href="/exports/csv" target="_blank">${t("investments.export_csv")}</a>
    </div>
    <div class="card">
      ${cache.length ? renderTable(cache) : emptyState()}
    </div>
    <div id="modal-host"></div>
  `;

  document.getElementById("btn-add").onclick = () => openForm();
  document.getElementById("btn-wallet").onclick = () => openWalletModal();
  document.getElementById("csv-input").onchange = onCsvUpload;
  document.getElementById("inv-search").oninput = (e) => { filterText = e.target.value.toLowerCase(); refresh(root); };
  attachRowHandlers(root);
}

function refresh(root) {
  const card = root.querySelector(".card");
  card.innerHTML = cache.length ? renderTable(cache) : emptyState();
  attachRowHandlers(root);
}

function attachRowHandlers(root) {
  for (const th of root.querySelectorAll("th[data-sort]")) {
    th.onclick = () => {
      const k = th.dataset.sort;
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
      refresh(root);
    };
  }
  for (const btn of root.querySelectorAll(".inv-edit")) btn.onclick = () => openForm(parseInt(btn.dataset.id, 10));
  for (const btn of root.querySelectorAll(".inv-delete")) btn.onclick = () => deleteInv(parseInt(btn.dataset.id, 10), root);
  const empty = root.querySelector("#empty-add"); if (empty) empty.onclick = () => openForm();
}

function renderTable(rows) {
  const filtered = rows.filter(r => !filterText || `${r.name} ${r.symbol || ""}`.toLowerCase().includes(filterText));
  filtered.sort((a, b) => (a[sortKey] > b[sortKey] ? 1 : -1) * sortDir);
  const tdir = (k) => sortKey === k ? (sortDir === 1 ? " ↑" : " ↓") : "";
  return `
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th data-sort="name">${t("investments.name")}${tdir("name")}</th>
            <th data-sort="type">${t("investments.type")}${tdir("type")}</th>
            <th data-sort="symbol">${t("investments.symbol")}${tdir("symbol")}</th>
            <th data-sort="quantity" style="text-align:right">${t("investments.quantity")}${tdir("quantity")}</th>
            <th data-sort="amount_invested" style="text-align:right">${t("investments.invested")}${tdir("amount_invested")}</th>
            <th data-sort="current_value" style="text-align:right">${t("investments.current")}${tdir("current_value")}</th>
            <th data-sort="purchase_date">${t("investments.purchase_date")}${tdir("purchase_date")}</th>
            <th data-sort="roi_pct" style="text-align:right">${t("investments.roi")}${tdir("roi_pct")}</th>
            <th>${t("investments.actions")}</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(r => `
            <tr>
              <td>${escapeHtml(r.name)}</td>
              <td>${t(`investments.types.${r.type}`)}</td>
              <td>${escapeHtml(r.symbol || "—")}</td>
              <td style="text-align:right">${r.quantity == null ? "—" : Number(r.quantity).toLocaleString(undefined, { maximumFractionDigits: 8 })}</td>
              <td style="text-align:right">${money(r.amount_invested)}</td>
              <td style="text-align:right">${money(r.current_value)}</td>
              <td>${r.purchase_date}</td>
              <td style="text-align:right"><span class="badge ${badgeClass(r.roi_pct)}">${pct(r.roi_pct)}</span></td>
              <td>
                <button class="btn btn-ghost inv-edit" data-id="${r.id}">${t("investments.edit")}</button>
                <button class="btn btn-ghost inv-delete" data-id="${r.id}">×</button>
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

function badgeClass(roi) {
  if (roi >= 5) return "green";
  if (roi <= -5) return "red";
  return "yellow";
}

// ---------- Add / edit form ----------
function openForm(id) {
  const inv = id ? cache.find(r => r.id === id) : null;
  const host = document.getElementById("modal-host");
  const initialInputMode = inv && inv.quantity ? "units" : "usd";
  const today = new Date().toISOString().slice(0, 10);

  host.innerHTML = `
    <div class="modal-overlay" id="form-overlay">
      <div class="modal-panel">
        <div class="modal-header">
          <strong>${inv ? t("investments.edit") : t("investments.add")}</strong>
          <button class="icon-btn" id="form-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <!-- Asset picker -->
          <div class="field" id="asset-picker-wrap">
            <label>${t("investments.pick_asset")}</label>
            <input id="asset-search" placeholder="${t("investments.search_asset_hint")}" autocomplete="off"/>
            <div id="asset-results" class="asset-results"></div>
          </div>

          <form id="inv-form">
            <input type="hidden" name="picked_id" value=""/>
            <div class="row">
              <div class="col field"><label>${t("investments.name")}</label>
                <input name="name" required value="${inv ? escapeHtml(inv.name) : ""}"/></div>
              <div class="col field"><label>${t("investments.symbol")}</label>
                <input name="symbol" value="${inv ? escapeHtml(inv.symbol || "") : ""}"/></div>
            </div>
            <div class="row">
              <div class="col field"><label>${t("investments.type")}</label>
                <select name="type">${TYPES.map(t2 => `<option value="${t2}" ${inv && inv.type === t2 ? "selected" : ""}>${t(`investments.types.${t2}`)}</option>`).join("")}</select>
              </div>
              <div class="col field"><label>${t("investments.purchase_date")}</label>
                <input name="purchase_date" type="date" required value="${inv ? inv.purchase_date : today}"/></div>
            </div>

            <!-- Input mode toggle -->
            <div class="field" id="mode-toggle-wrap">
              <label>${t("investments.input_mode")}</label>
              <div class="mode-toggle">
                <label><input type="radio" name="input_mode" value="usd" ${initialInputMode === "usd" ? "checked" : ""}/> ${t("investments.input_usd")}</label>
                <label><input type="radio" name="input_mode" value="units" ${initialInputMode === "units" ? "checked" : ""}/> ${t("investments.input_units")}</label>
              </div>
            </div>

            <!-- USD mode fields -->
            <div id="usd-fields">
              <div class="row">
                <div class="col field"><label>${t("investments.invested")} (USD)</label>
                  <input name="amount_invested" type="number" step="0.01" min="0.01" value="${inv ? inv.amount_invested : ""}"/></div>
                <div class="col field"><label>${t("investments.current")} (USD)</label>
                  <input name="current_value" type="number" step="0.01" min="0" value="${inv ? inv.current_value : ""}"/></div>
              </div>
              <div id="usd-calc-hint" class="hint" style="margin-top:-6px"></div>
            </div>

            <!-- Units mode fields -->
            <div id="units-fields" style="display:none">
              <div class="row">
                <div class="col field"><label>${t("investments.quantity")}</label>
                  <input name="quantity" type="number" step="any" min="0" value="${inv && inv.quantity ? inv.quantity : ""}"/></div>
                <div class="col field"><label id="ppu-label">${t("investments.price_per_unit")}</label>
                  <input name="price_per_unit" type="number" step="any" min="0" placeholder="—"/>
                  <div id="ppu-hint" class="hint"></div>
                </div>
                <div class="col field"><label>${t("investments.current")} (USD)</label>
                  <input name="current_value_units" type="number" step="0.01" min="0" value="${inv ? inv.current_value : ""}"/></div>
              </div>
              <div id="units-total-preview" class="hint" style="margin-top:-6px"></div>
            </div>

            <div class="field"><label>${t("investments.notes")}</label>
              <textarea name="notes" rows="2">${inv ? escapeHtml(inv.notes || "") : ""}</textarea></div>

            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
              <button class="btn btn-ghost" type="button" id="form-cancel">${t("investments.cancel")}</button>
              <button class="btn btn-primary" type="submit">${t("investments.save")}</button>
            </div>
          </form>
        </div>
      </div>
    </div>`;

  injectModalStyles();
  setupAssetPicker();
  setupInputModeToggle();
  setupHistoricalPriceTracking();

  document.getElementById("form-close").onclick = closeModal;
  document.getElementById("form-cancel").onclick = closeModal;
  document.getElementById("form-overlay").onclick = (ev) => { if (ev.target.id === "form-overlay") closeModal(); };

  document.getElementById("inv-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const mode = fd.get("input_mode") || "usd";

    const payload = {
      name: fd.get("name").trim(),
      type: fd.get("type"),
      symbol: (fd.get("symbol") || "").trim() || undefined,
      purchase_date: fd.get("purchase_date"),
      notes: (fd.get("notes") || "").trim() || undefined,
    };

    if (mode === "usd") {
      const inv = parseFloat(fd.get("amount_invested"));
      const cur = parseFloat(fd.get("current_value"));
      if (!isFinite(inv) || inv <= 0) { toast("Invested amount must be > 0", "error"); return; }
      if (!isFinite(cur) || cur < 0) { toast("Current value must be ≥ 0", "error"); return; }
      payload.amount_invested = inv;
      payload.current_value = cur;
    } else {
      const qty = parseFloat(fd.get("quantity"));
      const ppu = parseFloat(fd.get("price_per_unit"));
      const cur = parseFloat(fd.get("current_value_units"));
      if (!isFinite(qty) || qty <= 0) { toast("Quantity must be > 0", "error"); return; }
      if (!isFinite(ppu) || ppu <= 0) { toast("Price per unit must be > 0", "error"); return; }
      if (!isFinite(cur) || cur < 0) { toast("Current value must be ≥ 0", "error"); return; }
      payload.quantity = qty;
      payload.amount_invested = qty * ppu;
      payload.current_value = cur;
    }

    try {
      if (id) await API.request(`/investments/${id}`, { method: "PUT", body: payload });
      else await API.request("/investments/", { method: "POST", body: payload });
      toast(t("common.saved"), "success");
      closeModal();
      cache = await API.request("/investments/");
      refresh(document);
    } catch (e) { toast(e.message, "error"); }
  };
}

function setupInputModeToggle() {
  const radios = document.querySelectorAll('input[name="input_mode"]');
  const usd = document.getElementById("usd-fields");
  const units = document.getElementById("units-fields");
  const apply = () => {
    const mode = document.querySelector('input[name="input_mode"]:checked').value;
    usd.style.display = mode === "usd" ? "" : "none";
    units.style.display = mode === "units" ? "" : "none";
    recomputeCurrentValues();
  };
  radios.forEach(r => r.addEventListener("change", apply));
  apply();
}

// ---------- Live recompute wiring ----------
function setupHistoricalPriceTracking() {
  const dateInput = document.querySelector('input[name="purchase_date"]');
  const qtyInput = document.querySelector('input[name="quantity"]');
  const ppuInput = document.querySelector('input[name="price_per_unit"]');
  const investedInput = document.querySelector('input[name="amount_invested"]');

  if (dateInput) {
    dateInput.addEventListener("change", () => {
      clearTimeout(histPriceTimer);
      histPriceTimer = setTimeout(fetchHistoricalPrice, 150);
    });
  }
  if (qtyInput) qtyInput.addEventListener("input", updateUnitsCalc);
  if (ppuInput) ppuInput.addEventListener("input", updateUnitsCalc);
  if (investedInput) investedInput.addEventListener("input", recomputeUsdMode);
}

async function fetchHistoricalPrice() {
  if (!pickedAsset) return;
  const dateInput = document.querySelector('input[name="purchase_date"]');
  if (!dateInput) return;
  const date = dateInput.value;
  if (!date) return;

  const isCryptoId = !!pickedAsset.id;
  const sym = isCryptoId ? pickedAsset.id : pickedAsset.symbol;
  const at = isCryptoId ? "crypto" : (pickedAsset.type === "etf" ? "etf" : "stock");

  const ppuInput = document.querySelector('input[name="price_per_unit"]');
  const hint = document.getElementById("ppu-hint");
  if (hint) hint.innerHTML = `<span style="opacity:0.7">fetching price on ${date}…</span>`;

  try {
    const data = await API.request(
      `/markets/price-on/${encodeURIComponent(sym)}?date=${date}&asset_type=${at}`
    );
    if (data?.price != null) {
      historicalPrice = data.price;
      const formatted = data.price >= 1
        ? data.price.toFixed(2)
        : (data.price >= 0.01 ? data.price.toFixed(4) : data.price.toFixed(8));
      if (ppuInput) ppuInput.value = formatted;
      const note = data.date_actual && data.date_actual !== data.date_requested
        ? `Nearest trading day: ${data.date_actual}`
        : `Price on ${data.date_actual}`;
      if (hint) hint.innerHTML = `<span style="color:var(--success)">✓ ${note} — $${formatted}</span>`;
    }
  } catch (e) {
    if (hint) hint.innerHTML = `<span style="color:var(--danger)">${escapeHtml(e.message || "couldn't fetch")} — enter manually</span>`;
  }
  recomputeCurrentValues();
}

// Runs both mode recomputes — call after any live/historical/qty/amount change.
function recomputeCurrentValues() {
  recomputeUsdMode();
  updateUnitsCalc();
}

// Mode USD: "I invested $X on date Y in asset Z. What's it worth now?"
// implied_qty = invested / historical_price
// current_value = implied_qty × current_live_price
function recomputeUsdMode() {
  const hint = document.getElementById("usd-calc-hint");
  if (!hint) return;
  const investedEl = document.querySelector('input[name="amount_invested"]');
  const currentEl = document.querySelector('input[name="current_value"]');
  const invested = parseFloat(investedEl?.value);

  if (!isFinite(invested) || invested <= 0) { hint.innerHTML = ""; return; }
  if (!historicalPrice || !currentLivePrice) {
    hint.innerHTML = pickedAsset
      ? `<span style="color:var(--text-muted)">Pick a date to auto-compute current value</span>`
      : "";
    return;
  }

  const qty = invested / historicalPrice;
  const currentVal = qty * currentLivePrice;
  const gain = currentVal - invested;
  const gainPct = (gain / invested) * 100;

  if (currentEl) currentEl.value = currentVal.toFixed(2);

  const qtyStr = qty >= 1 ? qty.toFixed(4) : qty.toFixed(8);
  const gainColor = gain >= 0 ? "var(--success)" : "var(--danger)";
  hint.innerHTML = `<span style="color:var(--text-muted)">≈ ${qtyStr} unit(s) at $${historicalPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} → now <strong style="color:var(--text)">$${currentVal.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong> · <span style="color:${gainColor}">${gain >= 0 ? "+" : ""}${gainPct.toFixed(2)}%</span></span>`;
}

// Mode Units: extends the simple total with current value + gain when live price known.
function updateUnitsCalc() {
  const out = document.getElementById("units-total-preview");
  if (!out) return;
  const qty = parseFloat(document.querySelector('input[name="quantity"]')?.value);
  const ppu = parseFloat(document.querySelector('input[name="price_per_unit"]')?.value);
  const curEl = document.querySelector('input[name="current_value_units"]');

  if (!isFinite(qty) || qty <= 0) { out.innerHTML = ""; return; }

  const parts = [];
  let total = null;
  if (isFinite(ppu) && ppu > 0) {
    total = qty * ppu;
    parts.push(`Invested <strong style="color:var(--text)">$${total.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong>`);
  }
  if (currentLivePrice != null) {
    const currentVal = qty * currentLivePrice;
    if (curEl) curEl.value = currentVal.toFixed(2);
    parts.push(`now <strong style="color:var(--text)">$${currentVal.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong>`);
    if (total != null) {
      const gain = currentVal - total;
      const gainPct = (gain / total) * 100;
      const gainColor = gain >= 0 ? "var(--success)" : "var(--danger)";
      parts.push(`<span style="color:${gainColor}">${gain >= 0 ? "+" : ""}${gainPct.toFixed(2)}%</span>`);
    }
  }
  out.innerHTML = `<span style="color:var(--text-muted)">${parts.join(" · ")}</span>`;
}

// ---------- Asset picker (search + dropdown) ----------
let assetSearchTimer = null;

function setupAssetPicker() {
  const input = document.getElementById("asset-search");
  const results = document.getElementById("asset-results");
  if (!input) return;
  input.oninput = () => {
    clearTimeout(assetSearchTimer);
    const q = input.value.trim();
    if (!q || q.length < 2) { results.innerHTML = ""; return; }
    assetSearchTimer = setTimeout(() => searchAsset(q), 250);
  };
}

async function searchAsset(q) {
  const results = document.getElementById("asset-results");
  results.innerHTML = `<div class="asset-loading">${spinner()}</div>`;
  try {
    const data = await API.request(`/markets/search?q=${encodeURIComponent(q)}&limit=8`);
    if (!data.results || !data.results.length) {
      results.innerHTML = `<div class="asset-empty">— ${t("investments.or_manual")} —</div>`;
      return;
    }
    results.innerHTML = data.results.map(r => `
      <button type="button" class="asset-row" data-symbol="${escapeHtml(r.symbol)}" data-name="${escapeHtml(r.name || r.symbol)}" data-type="${escapeHtml(r.type || "stock")}" data-id="${escapeHtml(r.id || "")}">
        <strong>${escapeHtml(r.symbol)}</strong>
        <span class="asset-name">${escapeHtml(r.name || "")}</span>
        <span class="badge gray asset-type">${escapeHtml(r.type || "stock")}</span>
      </button>
    `).join("");
    for (const row of results.querySelectorAll(".asset-row")) {
      row.onclick = () => pickAsset(row);
    }
  } catch (e) {
    results.innerHTML = `<div class="asset-empty">${escapeHtml(e.message)}</div>`;
  }
}

async function pickAsset(row) {
  const sym = row.dataset.symbol;
  const id = row.dataset.id;
  const name = row.dataset.name;
  const type = (row.dataset.type || "stock").toLowerCase();
  const typeMap = { equity: "stock", cryptocurrency: "crypto", crypto: "crypto", etf: "etf" };
  const normType = typeMap[type] || (TYPES.includes(type) ? type : "stock");

  document.querySelector('input[name="name"]').value = name;
  document.querySelector('input[name="symbol"]').value = sym;
  document.querySelector('select[name="type"]').value = normType;
  document.getElementById("asset-search").value = `${sym} — ${name}`;
  document.getElementById("asset-results").innerHTML = `<div class="asset-loading">${spinner()} fetching live price…</div>`;

  // Remember the picked asset so the date input can refresh the historical price.
  pickedAsset = { id: id || null, symbol: sym, type: normType };
  currentLivePrice = null;
  historicalPrice = null;

  // Fetch the live (current) price — kept in state so any recompute can use it.
  try {
    let price = null;
    if (id) {
      const data = await API.request(`/market/crypto/${encodeURIComponent(id)}`);
      price = data?.price_usd;
    } else {
      const data = await API.request(`/market/price/${encodeURIComponent(sym)}`);
      price = data?.price;
    }
    if (price != null && isFinite(price)) {
      currentLivePrice = price;
      const formatted = price >= 1 ? price.toFixed(2) : (price >= 0.01 ? price.toFixed(4) : price.toFixed(8));
      document.getElementById("asset-results").innerHTML =
        `<div class="asset-empty">✓ live price: $${formatted}</div>`;
    } else {
      document.getElementById("asset-results").innerHTML =
        `<div class="asset-empty">No live price found — enter manually</div>`;
    }
  } catch (e) {
    console.warn("pickAsset live price fetch failed:", e);
    document.getElementById("asset-results").innerHTML = "";
  }

  // Then fetch the historical price for the purchase date (both modes use it).
  fetchHistoricalPrice();
  recomputeCurrentValues();
}

// ---------- Connect Wallet modal ----------
function openWalletModal() {
  const host = document.getElementById("modal-host");
  host.innerHTML = `
    <div class="modal-overlay" id="wallet-overlay">
      <div class="modal-panel">
        <div class="modal-header">
          <strong>${t("investments.wallet.title")}</strong>
          <button class="icon-btn" id="wallet-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <p style="color:var(--text-muted);font-size:13px;margin-top:0">${t("investments.wallet.subtitle")}</p>
          <div class="row">
            <div class="col field"><label>${t("investments.wallet.chain")}</label>
              <select id="wallet-chain">
                <option value="btc">Bitcoin (BTC)</option>
                <option value="eth">Ethereum (ETH)</option>
              </select>
            </div>
          </div>
          <div class="field"><label>${t("investments.wallet.address")}</label>
            <input id="wallet-address" placeholder="${t("investments.wallet.btc_placeholder")}"/></div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost" id="wallet-preview">${t("investments.wallet.preview")}</button>
            <button class="btn btn-primary" id="wallet-sync" disabled>${t("investments.wallet.sync")}</button>
            <span style="flex:1"></span>
            <button class="btn btn-ghost" id="wallet-cancel">${t("investments.wallet.cancel")}</button>
          </div>
          <div id="wallet-result" style="margin-top:14px"></div>
        </div>
      </div>
    </div>
  `;
  injectModalStyles();
  const chainSel = document.getElementById("wallet-chain");
  const addrInput = document.getElementById("wallet-address");
  chainSel.onchange = () => {
    addrInput.placeholder = chainSel.value === "btc"
      ? t("investments.wallet.btc_placeholder")
      : t("investments.wallet.eth_placeholder");
  };

  document.getElementById("wallet-close").onclick = closeModal;
  document.getElementById("wallet-cancel").onclick = closeModal;
  document.getElementById("wallet-overlay").onclick = (ev) => { if (ev.target.id === "wallet-overlay") closeModal(); };

  document.getElementById("wallet-preview").onclick = async () => {
    const chain = chainSel.value;
    const address = addrInput.value.trim();
    if (!address) { toast("Address required", "error"); return; }
    const out = document.getElementById("wallet-result");
    out.innerHTML = `<div style="text-align:center;padding:14px">${spinner()}</div>`;
    try {
      const data = await API.request("/wallet/preview", { method: "POST", body: { chain, address } });
      out.innerHTML = renderWalletResult(data);
      document.getElementById("wallet-sync").disabled = false;
    } catch (e) {
      out.innerHTML = `<div class="alert-banner error">${escapeHtml(e.message)}</div>`;
      document.getElementById("wallet-sync").disabled = true;
    }
  };

  document.getElementById("wallet-sync").onclick = async () => {
    const chain = chainSel.value;
    const address = addrInput.value.trim();
    try {
      const res = await API.request("/wallet/sync", { method: "POST", body: { chain, address } });
      toast(`${t("investments.wallet.synced")} (${res.action})`, "success");
      closeModal();
      cache = await API.request("/investments/");
      refresh(document);
    } catch (e) { toast(e.message, "error"); }
  };
}

function renderWalletResult(w) {
  return `
    <div class="card" style="margin:0">
      <div class="row">
        <div class="col">
          <div style="color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.1em">${t("investments.wallet.balance")}</div>
          <div style="font-family:var(--font-serif);font-size:22px">${Number(w.balance).toLocaleString(undefined, { maximumFractionDigits: 8 })} ${escapeHtml(w.currency)}</div>
        </div>
        <div class="col">
          <div style="color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.1em">${t("investments.wallet.value_usd")}</div>
          <div style="font-family:var(--font-serif);font-size:22px">${w.balance_usd == null ? "—" : "$" + Number(w.balance_usd).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        </div>
      </div>
      <div style="color:var(--text-muted);font-size:11px;margin-top:6px">${escapeHtml(w.address)} · ${escapeHtml(w.source)}</div>
    </div>`;
}

// ---------- Modal shared bits ----------
function closeModal() {
  document.getElementById("modal-host").innerHTML = "";
  // Reset the per-form state so the next open starts fresh.
  pickedAsset = null;
  currentLivePrice = null;
  historicalPrice = null;
}

async function deleteInv(id, root) {
  if (!confirm(t("investments.confirm_delete"))) return;
  try {
    await API.request(`/investments/${id}`, { method: "DELETE" });
    cache = cache.filter(r => r.id !== id);
    toast(t("common.deleted"), "success");
    refresh(root);
  } catch (e) { toast(e.message, "error"); }
}

async function onCsvUpload(ev) {
  const f = ev.target.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append("file", f);
  try {
    const res = await API.request("/investments/import", { method: "POST", body: fd });
    toast(`Imported ${res.imported}, skipped ${res.skipped}`, res.skipped ? "info" : "success");
    if (res.errors.length) console.warn("CSV import errors:", res.errors);
    cache = await API.request("/investments/");
    refresh(document);
  } catch (e) { toast(e.message, "error"); }
  ev.target.value = "";
}

// ---------- Styles ----------
function injectModalStyles() {
  if (document.getElementById("inv-modal-styles")) return;
  const css = `
    .modal-overlay {
      position: fixed; inset: 0; background: rgba(42, 36, 30, 0.45);
      z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .modal-panel {
      background: var(--surface); border-radius: var(--radius); border: 1px solid var(--border);
      box-shadow: var(--shadow-lg); width: 100%; max-width: 640px;
      max-height: 90vh; display: flex; flex-direction: column;
    }
    .modal-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 18px 22px; border-bottom: 1px solid var(--border);
    }
    .modal-header strong { font-family: var(--font-serif); font-size: 20px; font-weight: 500; }
    .modal-body { padding: 22px; overflow-y: auto; }
    .asset-results { margin-top: 6px; max-height: 260px; overflow-y: auto; }
    .asset-row {
      display: flex; gap: 10px; align-items: center; width: 100%;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius-sm); padding: 10px 14px; margin-bottom: 4px;
      cursor: pointer; text-align: left; font-family: inherit; font-size: 13px;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .asset-row:hover { background: var(--surface-2); border-color: var(--border-strong); }
    .asset-row strong { font-size: 13px; min-width: 80px; }
    .asset-row .asset-name { flex: 1; color: var(--text-muted); }
    .asset-row .asset-type { margin-left: auto; }
    .asset-loading, .asset-empty {
      padding: 12px; text-align: center; color: var(--text-muted); font-size: 12px;
    }
    .mode-toggle { display: flex; gap: 22px; align-items: center; flex-wrap: wrap; }
    /* Override the global .field label rules (uppercase + bold + display:block)
       which would otherwise stack the radios on top of each other. */
    .mode-toggle label {
      display: inline-flex !important;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 400;
      text-transform: none;
      letter-spacing: normal;
      margin-bottom: 0;
      color: var(--text);
      cursor: pointer;
    }
    .mode-toggle input[type="radio"] {
      width: 16px;
      height: 16px;
      margin: 0;
      padding: 0;
      flex-shrink: 0;
      accent-color: var(--primary);
    }
    .hint { font-size: 12px; margin-top: 4px; min-height: 16px; }
  `;
  const s = document.createElement("style");
  s.id = "inv-modal-styles";
  s.textContent = css;
  document.head.appendChild(s);
}
