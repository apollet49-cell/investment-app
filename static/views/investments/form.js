// Add / edit investment modal. Big HTML template + the submit handler
// that translates form fields into a payload and runs an optimistic save:
// paints the new row immediately with a temp id, fires the API call in
// the background, then either replaces the temp with the server row or
// rolls back + toasts.
import { API, escapeHtml, invalidateCache, seedCache, state, toast, track } from "/static/app.js";
import { t } from "/static/i18n.js";

import { TYPES, UNIT_CAPABLE_TYPES, formState, tableState } from "./state.js";
import { closeModal, injectModalStyles } from "./modal_shared.js";
import {
  setupHistoricalPriceTracking,
  setupInputModeToggle,
  setupRealEstateToggle,
} from "./form_inputs.js";
import { autoPickFromExisting, setupAssetPicker } from "./asset_picker.js";

export function openForm(id, refresh) {
  const inv = id ? tableState.cache.find(r => r.id === id) : null;
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

  // In edit mode, kick off a re-pick of the saved asset so the live price
  // and the historical price get fetched and the "current value"
  // recomputes automatically — saves the user from having to re-search
  // the catalogue.
  if (inv && inv.symbol && UNIT_CAPABLE_TYPES.has(inv.type)) {
    autoPickFromExisting(inv);
  }

  document.getElementById("form-close").onclick = closeModal;
  document.getElementById("form-cancel").onclick = closeModal;
  document.getElementById("form-overlay").onclick = (ev) => { if (ev.target.id === "form-overlay") closeModal(); };

  document.getElementById("inv-form").onsubmit = (ev) => onSubmit(ev, id, inv, refresh);
}

async function onSubmit(ev, id, inv, refresh) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const mode = fd.get("input_mode") || "usd";

  const invType = fd.get("type");
  const payload = {
    name: fd.get("name").trim(),
    type: invType,
    symbol: (fd.get("symbol") || "").trim() || undefined,
    purchase_date: fd.get("purchase_date"),
    notes: (fd.get("notes") || "").trim() || undefined,
  };
  const acct = (fd.get("account_type") || "").toString().trim();
  if (acct) payload.account_type = acct;

  // Type-gated fields: only send what's meaningful for the current type so
  // a user who switched type=real_estate→stock doesn't carry over a phantom
  // €1100/mo rent into a stock row (the hidden inputs still exist in the
  // form DOM and would otherwise leak via FormData).
  if (invType === "real_estate") {
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
  }
  if (invType === "startup") {
    const ay = parseFloat(fd.get("annual_yield_pct"));
    if (isFinite(ay)) payload.annual_yield_pct = ay;
  }

  if (mode === "usd") {
    const inv2 = parseFloat(fd.get("amount_invested"));
    const cur = parseFloat(fd.get("current_value"));
    if (!isFinite(inv2) || inv2 <= 0) { toast("Invested amount must be > 0", "error"); return; }
    if (!isFinite(cur) || cur < 0) { toast("Current value must be ≥ 0", "error"); return; }
    payload.amount_invested = inv2;
    payload.current_value = cur;
    // If we know the historical price (asset picked + date set), derive
    // the implied quantity and store it. This unlocks live current-value
    // refresh on subsequent GET /investments calls.
    if (formState.historicalPrice && formState.historicalPrice > 0) {
      payload.quantity = inv2 / formState.historicalPrice;
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

  // Optimistic add/edit: close the modal, paint the new row immediately
  // with a temp id, fire the API call in the background. On success we
  // replace the temp with the server row (real id, server-side roi_pct).
  // On failure we rollback and surface a toast.
  const snapshot = tableState.cache.slice();
  if (id) {
    tableState.cache = tableState.cache.map(r => r.id === id ? { ...r, ...payload, id } : r);
  } else {
    const tmpId = -Math.floor(Math.random() * 1e9) - 1;
    const tempRow = { id: tmpId, user_id: state.user?.id, _optimistic: true, ...payload };
    if (payload.amount_invested > 0) {
      tempRow.roi_pct = Math.round(((payload.current_value - payload.amount_invested) / payload.amount_invested) * 10000) / 100;
    }
    tableState.cache = [tempRow, ...tableState.cache];
  }
  closeModal();
  refresh(document);

  try {
    let saved;
    if (id) {
      saved = await API.request(`/investments/${id}`, { method: "PUT", body: payload });
      track("investment_edited", { type: invType });
    } else {
      saved = await API.request("/investments/", { method: "POST", body: payload });
      track("investment_added", { type: invType });
    }
    toast(t("common.saved"), "success");
    if (id) {
      tableState.cache = tableState.cache.map(r => r.id === id ? saved : r);
    } else {
      const tmpIdx = tableState.cache.findIndex(r => r._optimistic);
      if (tmpIdx >= 0) tableState.cache[tmpIdx] = saved;
      else tableState.cache = [saved, ...tableState.cache];
    }
    invalidateCache("/dashboard/");
    seedCache("/investments/", tableState.cache);
    refresh(document);
  } catch (e) {
    tableState.cache = snapshot;
    refresh(document);
    toast(`${t("common.error_generic")} — ${escapeHtml(e.message)}`, "error");
  }
}
