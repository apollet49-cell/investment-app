import { API, money, pct, spinner, toast, escapeHtml, onViewCleanup } from "/static/app.js";
import { t } from "/static/i18n.js";

const TYPES = ["stock", "real_estate", "crypto", "bond", "etf", "startup"];
const UNIT_CAPABLE_TYPES = new Set(["stock", "etf", "crypto"]);

let cache = [];
let filterText = "";
let filterType = "all";
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
      <input id="inv-search" class="grow" placeholder="${t("investments.search_placeholder")}" value="${escapeHtml(filterText)}" />
      <select id="inv-type-filter" class="btn btn-ghost" style="cursor:pointer">
        <option value="all">${t("investments.filter_all_types")}</option>
        ${TYPES.map(typ => `<option value="${typ}" ${filterType === typ ? "selected" : ""}>${t(`investments.types.${typ}`)}</option>`).join("")}
      </select>
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
    <div id="detail-modal-host"></div>
  `;

  document.getElementById("btn-add").onclick = () => openForm();
  document.getElementById("btn-wallet").onclick = () => openWalletModal();
  document.getElementById("csv-input").onchange = onCsvUpload;
  document.getElementById("inv-search").oninput = (e) => { filterText = e.target.value.toLowerCase(); refresh(root); };
  document.getElementById("inv-type-filter").onchange = (e) => { filterType = e.target.value; refresh(root); };
  attachRowHandlers(root);

  // Auto-refresh every 60s so live market prices flow into the table without
  // a manual reload. The `cancelled` flag guards the async callback so that
  // a fetch already in-flight when the user navigates away doesn't write
  // investments content into a view-root now owned by another view.
  let cancelled = false;
  const refreshTimer = setInterval(async () => {
    if (cancelled) return;
    try {
      const data = await API.request("/investments/");
      if (cancelled) return;
      cache = data;
      refresh(root);
    } catch (_) { /* network blip — try again next tick */ }
  }, 60000);
  onViewCleanup(() => { cancelled = true; clearInterval(refreshTimer); });
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
  for (const btn of root.querySelectorAll(".inv-whatif")) btn.onclick = () => openWhatIfModal(parseInt(btn.dataset.id, 10));
  for (const tr of root.querySelectorAll(".inv-row")) {
    tr.onclick = () => openDetailModal(parseInt(tr.dataset.id, 10));
  }
  const empty = root.querySelector("#empty-add"); if (empty) empty.onclick = () => openForm();
}

function renderTable(rows) {
  const filtered = rows
    .filter(r => filterType === "all" || r.type === filterType)
    .filter(r => !filterText || `${r.name} ${r.symbol || ""} ${r.city || ""}`.toLowerCase().includes(filterText));
  filtered.sort((a, b) => (a[sortKey] > b[sortKey] ? 1 : -1) * sortDir);
  const tdir = (k) => sortKey === k ? (sortDir === 1 ? " ↑" : " ↓") : "";
  if (filtered.length === 0) {
    return `<div class="empty-state" style="padding:30px 14px"><p>${t("investments.no_match")}</p></div>`;
  }
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;color:var(--text-muted);font-size:12px">
      <span>${t("investments.row_count", { count: filtered.length, total: rows.length })}</span>
      <span style="font-style:italic">${t("investments.click_row_hint")}</span>
    </div>
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
            <tr class="inv-row" data-id="${r.id}" style="cursor:pointer">
              <td><strong>${escapeHtml(r.name)}</strong></td>
              <td>${t(`investments.types.${r.type}`)}</td>
              <td>${escapeHtml(r.symbol || (r.city || "—"))}</td>
              <td style="text-align:right">${r.quantity == null ? "—" : Number(r.quantity).toLocaleString(undefined, { maximumFractionDigits: 8 })}</td>
              <td style="text-align:right">${money(r.amount_invested)}</td>
              <td style="text-align:right">${money(r.current_value)}</td>
              <td>${r.purchase_date}</td>
              <td style="text-align:right"><span class="badge ${badgeClass(r.roi_pct)}">${pct(r.roi_pct)}</span></td>
              <td onclick="event.stopPropagation()">
                <button class="btn btn-ghost inv-edit" data-id="${r.id}">${t("investments.edit")}</button>
                <button class="btn btn-ghost inv-whatif" data-id="${r.id}" title="${t("investments.whatif.title")}">${t("investments.whatif.button")}</button>
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
              <div class="col field"><label>${t("investments.account_type")}</label>
                <select name="account_type">
                  <option value="" ${!inv?.account_type ? "selected" : ""}>—</option>
                  <option value="cto" ${inv?.account_type === "cto" ? "selected" : ""}>${t("investments.account_cto")}</option>
                  <option value="pea" ${inv?.account_type === "pea" ? "selected" : ""}>${t("investments.account_pea")}</option>
                  <option value="av"  ${inv?.account_type === "av"  ? "selected" : ""}>${t("investments.account_av")}</option>
                  <option value="per" ${inv?.account_type === "per" ? "selected" : ""}>${t("investments.account_per")}</option>
                  <option value="other" ${inv?.account_type === "other" ? "selected" : ""}>${t("investments.account_other")}</option>
                </select></div>
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

            <!-- Real-estate-only block: rental income + charges + optional loan -->
            <div id="real-estate-fields" style="display:none;border-top:1px solid var(--border);padding-top:16px;margin-top:12px">
              <div style="font-family:var(--font-serif);font-size:16px;font-weight:500;margin-bottom:6px">${t("investments.real_estate.title")}</div>
              <div style="color:var(--text-muted);font-size:12px;margin-bottom:12px">${t("investments.real_estate.section_optional")}</div>
              <div class="row">
                <div class="col field"><label>${t("investments.real_estate.monthly_income")} (USD)</label>
                  <input name="monthly_rental_income" type="number" step="0.01" min="0"
                         value="${inv && inv.monthly_rental_income ? inv.monthly_rental_income : ""}"/></div>
                <div class="col field"><label>${t("investments.real_estate.monthly_charges")} (USD)</label>
                  <input name="monthly_rental_charges" type="number" step="0.01" min="0"
                         value="${inv && inv.monthly_rental_charges ? inv.monthly_rental_charges : ""}"/></div>
              </div>
              <div class="field" style="margin-top:4px">
                <label style="display:inline-flex !important;align-items:center;gap:8px;cursor:pointer;text-transform:none;letter-spacing:normal;font-weight:400;color:var(--text);margin-bottom:0">
                  <input type="checkbox" id="has-loan"
                         ${inv && (inv.loan_amount || inv.monthly_mortgage_payment) ? "checked" : ""}
                         style="width:16px;height:16px;accent-color:var(--primary)"/>
                  <span>${t("investments.real_estate.financed_by_loan")}</span>
                </label>
              </div>
              <div id="loan-fields" style="display:none">
                <div class="row">
                  <div class="col field"><label>${t("investments.real_estate.loan_amount")} (USD)</label>
                    <input name="loan_amount" type="number" step="0.01" min="0"
                           value="${inv && inv.loan_amount ? inv.loan_amount : ""}"/></div>
                  <div class="col field"><label>${t("investments.real_estate.loan_rate")} (%)</label>
                    <input name="loan_interest_rate_pct" type="number" step="0.01" min="0"
                           value="${inv && inv.loan_interest_rate_pct ? inv.loan_interest_rate_pct : ""}"/></div>
                  <div class="col field"><label>${t("investments.real_estate.monthly_mortgage")} (USD)</label>
                    <input name="monthly_mortgage_payment" type="number" step="0.01" min="0"
                           value="${inv && inv.monthly_mortgage_payment ? inv.monthly_mortgage_payment : ""}"/></div>
                </div>
              </div>
              <div id="cashflow-hint" class="hint" style="margin-top:6px"></div>

              <!-- Property details for auto-valuation via DVF (France) -->
              <div style="margin-top:18px;padding-top:14px;border-top:1px dashed var(--border)">
                <div style="font-family:var(--font-serif);font-size:14px;font-weight:500;margin-bottom:10px">${t("investments.real_estate.property_details")}</div>
                <div class="field"><label>${t("investments.real_estate.address")}</label>
                  <input name="address" value="${inv && inv.address ? escapeHtml(inv.address) : ""}"/></div>
                <div class="row">
                  <div class="col field"><label>${t("investments.real_estate.postal_code")}</label>
                    <input name="postal_code" value="${inv && inv.postal_code ? escapeHtml(inv.postal_code) : ""}"/></div>
                  <div class="col field"><label>${t("investments.real_estate.city")}</label>
                    <input name="city" value="${inv && inv.city ? escapeHtml(inv.city) : ""}"/></div>
                  <div class="col field"><label>${t("investments.real_estate.country")}</label>
                    <select name="country">
                      <option value="FR" ${!inv || inv.country === "FR" || !inv.country ? "selected" : ""}>${t("investments.real_estate.country_fr")}</option>
                      <option value="OTHER" ${inv && inv.country && inv.country !== "FR" ? "selected" : ""}>${t("investments.real_estate.country_other")}</option>
                    </select></div>
                </div>
                <div class="row">
                  <div class="col field"><label>${t("investments.real_estate.surface_sqm")} (m²)</label>
                    <input name="surface_sqm" type="number" step="0.1" min="0"
                           value="${inv && inv.surface_sqm ? inv.surface_sqm : ""}"/></div>
                  <div class="col field"><label>${t("investments.real_estate.property_subtype")}</label>
                    <select name="property_subtype">
                      <option value="apartment" ${!inv || inv.property_subtype === "apartment" || !inv.property_subtype ? "selected" : ""}>${t("investments.real_estate.subtype_apartment")}</option>
                      <option value="house" ${inv && inv.property_subtype === "house" ? "selected" : ""}>${t("investments.real_estate.subtype_house")}</option>
                      <option value="office" ${inv && inv.property_subtype === "office" ? "selected" : ""}>${t("investments.real_estate.subtype_office")}</option>
                    </select></div>
                  <div class="col field"><label>${t("investments.real_estate.garden_sqm")} (m²)</label>
                    <input name="garden_sqm" type="number" step="0.1" min="0"
                           value="${inv && inv.garden_sqm ? inv.garden_sqm : ""}"/></div>
                </div>
                <button type="button" class="btn btn-ghost" id="estimate-value-btn" style="margin-top:6px">
                  ${t("investments.real_estate.estimate_button")}
                </button>
                <div id="estimate-result" style="margin-top:12px"></div>
              </div>
            </div>

            <!-- Startup-only block: expected annual yield -->
            <div id="startup-fields" style="display:none;border-top:1px solid var(--border);padding-top:16px;margin-top:12px">
              <div style="font-family:var(--font-serif);font-size:16px;font-weight:500;margin-bottom:12px">${t("investments.startup.title")}</div>
              <div class="row">
                <div class="col field"><label>${t("investments.startup.annual_yield")} (%)</label>
                  <input name="annual_yield_pct" type="number" step="0.01"
                         value="${inv && inv.annual_yield_pct != null ? inv.annual_yield_pct : ""}"/></div>
              </div>
              <div id="yield-hint" class="hint"></div>
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
  setupRealEstateToggle();

  // In edit mode, kick off a re-pick of the saved asset so the live price and
  // the historical price get fetched and the "current value" recomputes
  // automatically — saves the user from having to re-search the catalogue.
  if (inv && inv.symbol && UNIT_CAPABLE_TYPES.has(inv.type)) {
    autoPickFromExisting(inv);
  }

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
    // Real-estate rental + loan fields (only meaningful when type === "real_estate"
    // but we send them whenever filled — the backend stores nullable values).
    const ri = parseFloat(fd.get("monthly_rental_income"));
    const rc = parseFloat(fd.get("monthly_rental_charges"));
    if (isFinite(ri) && ri >= 0) payload.monthly_rental_income = ri;
    if (isFinite(rc) && rc >= 0) payload.monthly_rental_charges = rc;
    const la = parseFloat(fd.get("loan_amount"));
    const lr = parseFloat(fd.get("loan_interest_rate_pct"));
    const mp = parseFloat(fd.get("monthly_mortgage_payment"));
    if (isFinite(la) && la >= 0) payload.loan_amount = la;
    if (isFinite(lr) && lr >= 0) payload.loan_interest_rate_pct = lr;
    if (isFinite(mp) && mp >= 0) payload.monthly_mortgage_payment = mp;
    // Startup yield
    const ay = parseFloat(fd.get("annual_yield_pct"));
    if (isFinite(ay)) payload.annual_yield_pct = ay;
    // Tax wrapper
    const acct = (fd.get("account_type") || "").toString().trim();
    if (acct) payload.account_type = acct;
    // Real-estate property details (all optional — used by DVF auto-valuation)
    const addr = (fd.get("address") || "").toString().trim();
    const pc = (fd.get("postal_code") || "").toString().trim();
    const city = (fd.get("city") || "").toString().trim();
    const ctry = (fd.get("country") || "").toString().trim();
    const surface = parseFloat(fd.get("surface_sqm"));
    const pst = (fd.get("property_subtype") || "").toString().trim();
    const gs = parseFloat(fd.get("garden_sqm"));
    if (addr) payload.address = addr;
    if (pc) payload.postal_code = pc;
    if (city) payload.city = city;
    if (ctry) payload.country = ctry;
    if (isFinite(surface) && surface > 0) payload.surface_sqm = surface;
    if (pst) payload.property_subtype = pst;
    if (isFinite(gs) && gs >= 0) payload.garden_sqm = gs;

    if (mode === "usd") {
      const inv = parseFloat(fd.get("amount_invested"));
      const cur = parseFloat(fd.get("current_value"));
      if (!isFinite(inv) || inv <= 0) { toast("Invested amount must be > 0", "error"); return; }
      if (!isFinite(cur) || cur < 0) { toast("Current value must be ≥ 0", "error"); return; }
      payload.amount_invested = inv;
      payload.current_value = cur;
      // If we know the historical price (asset picked + date set), derive the
      // implied quantity and store it. This unlocks live current-value refresh
      // on subsequent GET /investments calls.
      if (historicalPrice && historicalPrice > 0) {
        payload.quantity = inv / historicalPrice;
      }
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

// Show / hide the type-specific blocks (real_estate, startup) and wire all
// the live hints that depend on inputs in those blocks.
function setupRealEstateToggle() {
  const typeSelect = document.querySelector('select[name="type"]');
  const incomeInput = document.querySelector('input[name="monthly_rental_income"]');
  const chargesInput = document.querySelector('input[name="monthly_rental_charges"]');
  const mortgageInput = document.querySelector('input[name="monthly_mortgage_payment"]');
  const loanCheckbox = document.getElementById("has-loan");
  const loanFields = document.getElementById("loan-fields");
  const yieldInput = document.querySelector('input[name="annual_yield_pct"]');

  const updateVisibility = () => {
    const reFields = document.getElementById("real-estate-fields");
    const stFields = document.getElementById("startup-fields");
    const type = typeSelect?.value;
    if (reFields) reFields.style.display = type === "real_estate" ? "" : "none";
    if (stFields) stFields.style.display = type === "startup" ? "" : "none";
    updateCashflowHint();
    updateYieldHint();
  };
  const updateLoanVisibility = () => {
    if (loanFields) loanFields.style.display = loanCheckbox?.checked ? "" : "none";
    updateCashflowHint();
  };

  if (typeSelect) typeSelect.addEventListener("change", updateVisibility);
  if (incomeInput) incomeInput.addEventListener("input", updateCashflowHint);
  if (chargesInput) chargesInput.addEventListener("input", updateCashflowHint);
  if (mortgageInput) mortgageInput.addEventListener("input", updateCashflowHint);
  if (loanCheckbox) loanCheckbox.addEventListener("change", updateLoanVisibility);
  if (yieldInput) yieldInput.addEventListener("input", updateYieldHint);

  // Wire the DVF estimate button (visible only when the real-estate block is shown)
  const estimateBtn = document.getElementById("estimate-value-btn");
  if (estimateBtn) estimateBtn.onclick = estimateMarketValue;

  updateLoanVisibility();
  updateVisibility();
}

async function estimateMarketValue() {
  const out = document.getElementById("estimate-result");
  if (!out) return;
  const postal = document.querySelector('input[name="postal_code"]')?.value?.trim();
  const country = document.querySelector('select[name="country"]')?.value || "FR";
  const surface = parseFloat(document.querySelector('input[name="surface_sqm"]')?.value);
  const subtype = document.querySelector('select[name="property_subtype"]')?.value || "apartment";
  if (!postal || !isFinite(surface) || surface <= 0) {
    out.innerHTML = `<div class="alert-banner error" style="margin:0">${t("investments.real_estate.estimate_missing")}</div>`;
    return;
  }
  out.innerHTML = `<div class="hint">${spinner()} ${t("investments.real_estate.estimate_loading")}</div>`;
  try {
    const data = await API.request("/investments/estimate-value", {
      method: "POST",
      body: { postal_code: postal, country, surface_sqm: surface, property_subtype: subtype },
    });
    if (data.status === "ok") {
      const eurFmt = Number(data.estimated_value_local).toLocaleString("fr-FR", { maximumFractionDigits: 0 });
      const usdFmt = Number(data.estimated_value_usd).toLocaleString(undefined, { maximumFractionDigits: 0 });
      const ppsqmFmt = Number(data.median_price_per_sqm_local).toLocaleString("fr-FR", { maximumFractionDigits: 0 });
      out.innerHTML = `
        <div class="card" style="margin:0;padding:16px;background:var(--surface-2)">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap">
            <div>
              <div style="font-family:var(--font-serif);font-size:24px;line-height:1.2">€${eurFmt} <span style="color:var(--text-muted);font-size:14px">≈ $${usdFmt}</span></div>
              <div style="color:var(--text-muted);font-size:12px;margin-top:4px">${t("investments.real_estate.estimate_based_on", { n: data.comparable_count })} · ${t("investments.real_estate.estimate_median")} €${ppsqmFmt}/m²</div>
              <div style="color:var(--text-muted);font-size:11px;margin-top:2px">${escapeHtml(data.source || "")}</div>
            </div>
            <button type="button" class="btn btn-primary" id="apply-estimate-btn">${t("investments.real_estate.estimate_apply")}</button>
          </div>
        </div>`;
      document.getElementById("apply-estimate-btn").onclick = () => {
        const currentEl = document.querySelector('input[name="current_value"]');
        if (currentEl) currentEl.value = data.estimated_value_usd.toFixed(2);
        toast(t("investments.real_estate.estimate_applied"), "success");
      };
    } else if (data.status === "unsupported_country") {
      out.innerHTML = `<div class="alert-banner" style="margin:0">${escapeHtml(data.message || "")}</div>`;
    } else {
      out.innerHTML = `<div class="alert-banner" style="margin:0">${escapeHtml(data.message || t("investments.real_estate.estimate_no_match"))}</div>`;
    }
  } catch (e) {
    out.innerHTML = `<div class="alert-banner error" style="margin:0">${escapeHtml(e.message)}</div>`;
  }
}

function updateCashflowHint() {
  const hint = document.getElementById("cashflow-hint");
  if (!hint) return;
  const inc = parseFloat(document.querySelector('input[name="monthly_rental_income"]')?.value);
  const exp = parseFloat(document.querySelector('input[name="monthly_rental_charges"]')?.value);
  const mortgage = parseFloat(document.querySelector('input[name="monthly_mortgage_payment"]')?.value);
  const incVal = isFinite(inc) && inc > 0 ? inc : 0;
  const expVal = isFinite(exp) && exp > 0 ? exp : 0;
  const mortVal = isFinite(mortgage) && mortgage > 0 ? mortgage : 0;
  if (!incVal && !expVal && !mortVal) { hint.innerHTML = ""; return; }
  const net = incVal - expVal - mortVal;
  const annual = net * 12;
  const netColor = net >= 0 ? "var(--success)" : "var(--danger)";
  const sign = net >= 0 ? "+" : "−";
  const breakdown = mortVal > 0
    ? `<br><span style="color:var(--text-muted);font-size:11px">Rent ${money(incVal)} − Charges ${money(expVal)} − Mortgage ${money(mortVal)}</span>`
    : "";
  hint.innerHTML = `<span style="color:var(--text-muted)">${t("investments.real_estate.net_monthly")}: <strong style="color:${netColor}">${sign}${money(Math.abs(net))}</strong> · ${t("investments.real_estate.net_annual")}: <strong style="color:${netColor}">${sign}${money(Math.abs(annual))}</strong></span>${breakdown}`;
}

function updateYieldHint() {
  const hint = document.getElementById("yield-hint");
  if (!hint) return;
  const yieldPct = parseFloat(document.querySelector('input[name="annual_yield_pct"]')?.value);
  const investedEl = document.querySelector('input[name="amount_invested"]');
  const purchaseEl = document.querySelector('input[name="purchase_date"]');
  if (!isFinite(yieldPct) || !investedEl || !purchaseEl) { hint.innerHTML = ""; return; }
  const invested = parseFloat(investedEl.value);
  const purchase = purchaseEl.value;
  if (!isFinite(invested) || invested <= 0 || !purchase) { hint.innerHTML = ""; return; }
  // Compound the expected return between purchase date and today.
  const days = (Date.now() - new Date(purchase).getTime()) / (1000 * 60 * 60 * 24);
  if (!isFinite(days) || days < 0) { hint.innerHTML = ""; return; }
  const years = days / 365.25;
  const projected = invested * Math.pow(1 + yieldPct / 100, years);
  const gain = projected - invested;
  const color = gain >= 0 ? "var(--success)" : "var(--danger)";
  const sign = gain >= 0 ? "+" : "−";
  hint.innerHTML = `<span style="color:var(--text-muted)">Projected value today (${years.toFixed(1)} yr @ ${yieldPct}%/yr): <strong style="color:${color}">${money(projected)}</strong> (<span style="color:${color}">${sign}${money(Math.abs(gain))}</span>)</span>`;
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
    parts.push(`Invested <strong style="color:var(--text)">${money(total)}</strong>`);
  }
  if (currentLivePrice != null) {
    const currentVal = qty * currentLivePrice;
    if (curEl) curEl.value = currentVal.toFixed(2);
    parts.push(`now <strong style="color:var(--text)">${money(currentVal)}</strong>`);
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

// Build a synthetic "asset row" from an existing Investment and feed it to
// pickAsset(), so opening the edit modal re-fetches current + historical
// prices and refreshes the calculation without the user re-typing anything.
async function autoPickFromExisting(inv) {
  if (!inv || !inv.symbol) return;
  let coingeckoId = "";
  // Heuristic: a crypto whose symbol has no dash (e.g. "bitcoin") is likely a
  // CoinGecko id from the local catalogue. Symbols like "BTC-USD" are yfinance
  // tickers and should hit the yfinance path.
  if (inv.type === "crypto" && !inv.symbol.includes("-")) {
    coingeckoId = inv.symbol.toLowerCase();
  }
  const fakeRow = {
    dataset: {
      symbol: inv.symbol,
      name: inv.name,
      type: inv.type,
      id: coingeckoId,
    },
  };
  await pickAsset(fakeRow);
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

// ---------- What-if modal ----------
const WHATIF_QUICK = [
  { symbol: "SPY", name: "S&P 500 (SPY)", asset_type: "etf" },
  { symbol: "QQQ", name: "NASDAQ-100 (QQQ)", asset_type: "etf" },
  { symbol: "BTC-USD", name: "Bitcoin", asset_type: "crypto" },
  { symbol: "ETH-USD", name: "Ethereum", asset_type: "crypto" },
  { symbol: "GLD", name: "Gold (GLD)", asset_type: "etf" },
  { symbol: "VWRL.L", name: "FTSE All-World", asset_type: "etf" },
];

let whatifSearchTimer = null;

function openWhatIfModal(id) {
  const inv = cache.find(r => r.id === id);
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

// ---------- Detail modal (chart + news + facts for the picked investment) ----------
let detailChart = null;

async function openDetailModal(invId) {
  const inv = cache.find(r => r.id === invId);
  if (!inv) return;
  const host = document.getElementById("detail-modal-host");
  const roiClass = (inv.roi_pct || 0) >= 0 ? "var(--success)" : "var(--danger)";
  const roiSign = (inv.roi_pct || 0) >= 0 ? "+" : "";

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
            <div class="summary-card"><div class="label">${t("investments.roi")}</div><div class="value" style="font-size:18px;color:${roiClass}">${roiSign}${pct(inv.roi_pct)}</div></div>
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
      const at = inv.type === "etf" ? "etf" : (inv.type === "crypto" ? "crypto" : "stock");
      const data = await API.request(`/markets/asset/${encodeURIComponent(inv.symbol)}?asset_type=${at}&period=${period}`);
      const candles = data?.candles || [];
      const series = candles.map(c => ({ date: new Date(c.time * 1000).toISOString().slice(0, 10), close: c.close }));
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

  // News (best-effort — fail silently)
  try {
    const news = await API.request(`/markets/asset/${encodeURIComponent(inv.symbol)}/news`);
    const items = news?.items || news?.articles || news || [];
    const nbody = document.getElementById("detail-news-body");
    if (!items.length) { nbody.innerHTML = `<em>${t("investments.detail_no_news")}</em>`; return; }
    nbody.innerHTML = items.slice(0, 6).map(n => `
      <div style="padding:8px 0;border-bottom:1px solid var(--border)">
        <a href="${escapeHtml(n.url || n.link || '#')}" target="_blank" rel="noopener" style="color:var(--text);font-weight:500;text-decoration:none">${escapeHtml(n.title || n.headline || "—")}</a>
        <div style="color:var(--text-muted);font-size:11px;margin-top:2px">${escapeHtml(n.publisher || n.source || "")} · ${escapeHtml((n.published_at || n.date || "").slice(0, 10))}</div>
      </div>`).join("");
  } catch (_) {
    const nbody = document.getElementById("detail-news-body");
    if (nbody) nbody.innerHTML = `<em>${t("investments.detail_no_news")}</em>`;
  }
}

function drawDetailChart(series, inv) {
  const ctx = document.getElementById("detail-chart");
  if (!ctx || !window.Chart) return;
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
        <div><span style="color:var(--text-muted)">${t("investments.real_estate.surface") || "Surface"}:</span> <strong>${inv.surface_sqm ? inv.surface_sqm + " m²" : "—"}</strong></div>
        <div><span style="color:var(--text-muted)">${t("investments.real_estate.subtype") || "Type"}:</span> <strong>${escapeHtml(inv.property_subtype || "—")}</strong></div>
      </div>
      <div style="border-top:1px solid var(--border);margin:14px 0;padding-top:12px;font-size:13px">
        <div><span style="color:var(--text-muted)">${t("investments.real_estate.rent") || "Rent"}:</span> <strong>${money(rent)}/mo</strong></div>
        <div><span style="color:var(--text-muted)">${t("investments.real_estate.charges") || "Charges"}:</span> <strong>${money(charges)}/mo</strong></div>
        ${mort > 0 ? `<div><span style="color:var(--text-muted)">${t("investments.real_estate.mortgage") || "Mortgage"}:</span> <strong>${money(mort)}/mo</strong></div>` : ""}
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
      if (data?.estimated_value != null) {
        const delta = data.estimated_value - inv.current_value;
        const dc = delta >= 0 ? "var(--success)" : "var(--danger)";
        dvfHost.innerHTML = `
          <div style="font-weight:500;color:var(--text);margin-bottom:6px">${t("investments.detail_market_estimate")}</div>
          <div>${t("investments.detail_estimate_value")}: <strong>${money(data.estimated_value)}</strong>
            <span style="color:${dc};margin-left:8px">(${delta >= 0 ? "+" : ""}${money(delta)} ${t("investments.detail_vs_book")})</span></div>
          ${data.price_per_sqm ? `<div style="margin-top:4px;font-size:12px">${t("investments.detail_price_sqm")}: <strong>${money(data.price_per_sqm)}/m²</strong> · ${data.comparable_count || 0} ${t("investments.detail_comparables")}</div>` : ""}
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
