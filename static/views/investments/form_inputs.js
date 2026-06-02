// Live-recompute wiring for the add/edit form: the real-estate / startup
// blocks toggle on the type selector, the USD ↔ units mode toggle swaps
// which fieldset is visible, and the inputs continuously recompute the
// implied current value as the user types.
import { API, escapeHtml, money, spinner, toast } from "/static/app.js";
import { t } from "/static/i18n.js";

import { formState } from "./state.js";

// Visibility of the real-estate / startup sections, plus the wiring for
// the cashflow/yield hint and the DVF estimate button.
export function setupRealEstateToggle() {
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

export function setupInputModeToggle() {
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

export function setupHistoricalPriceTracking() {
  const dateInput = document.querySelector('input[name="purchase_date"]');
  const qtyInput = document.querySelector('input[name="quantity"]');
  const ppuInput = document.querySelector('input[name="price_per_unit"]');
  const investedInput = document.querySelector('input[name="amount_invested"]');

  if (dateInput) {
    dateInput.addEventListener("change", () => {
      clearTimeout(formState.histPriceTimer);
      formState.histPriceTimer = setTimeout(fetchHistoricalPrice, 150);
    });
  }
  if (qtyInput) qtyInput.addEventListener("input", updateUnitsCalc);
  if (ppuInput) ppuInput.addEventListener("input", updateUnitsCalc);
  if (investedInput) investedInput.addEventListener("input", recomputeUsdMode);
}

export async function fetchHistoricalPrice() {
  if (!formState.pickedAsset) return;
  const dateInput = document.querySelector('input[name="purchase_date"]');
  if (!dateInput) return;
  const date = dateInput.value;
  if (!date) return;

  const isCryptoId = !!formState.pickedAsset.id;
  const sym = isCryptoId ? formState.pickedAsset.id : formState.pickedAsset.symbol;
  const at = isCryptoId ? "crypto" : (formState.pickedAsset.type === "etf" ? "etf" : "stock");

  const ppuInput = document.querySelector('input[name="price_per_unit"]');
  const hint = document.getElementById("ppu-hint");
  if (hint) hint.innerHTML = `<span style="opacity:0.7">fetching price on ${date}…</span>`;

  try {
    const data = await API.request(
      `/market/price-on/${encodeURIComponent(sym)}?date=${date}&asset_type=${at}`
    );
    if (data?.price != null) {
      formState.historicalPrice = data.price;
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
export function recomputeCurrentValues() {
  recomputeUsdMode();
  updateUnitsCalc();
}

// Mode USD: "I invested $X on date Y in asset Z. What's it worth now?"
//   implied_qty   = invested / historical_price
//   current_value = implied_qty × current_live_price
function recomputeUsdMode() {
  const hint = document.getElementById("usd-calc-hint");
  if (!hint) return;
  const investedEl = document.querySelector('input[name="amount_invested"]');
  const currentEl = document.querySelector('input[name="current_value"]');
  const invested = parseFloat(investedEl?.value);

  if (!isFinite(invested) || invested <= 0) { hint.innerHTML = ""; return; }
  if (!formState.historicalPrice || !formState.currentLivePrice) {
    hint.innerHTML = formState.pickedAsset
      ? `<span style="color:var(--text-muted)">Pick a date to auto-compute current value</span>`
      : "";
    return;
  }

  const qty = invested / formState.historicalPrice;
  const currentVal = qty * formState.currentLivePrice;
  const gain = currentVal - invested;
  const gainPct = (gain / invested) * 100;

  if (currentEl) currentEl.value = currentVal.toFixed(2);

  const qtyStr = qty >= 1 ? qty.toFixed(4) : qty.toFixed(8);
  const gainColor = gain >= 0 ? "var(--success)" : "var(--danger)";
  hint.innerHTML = `<span style="color:var(--text-muted)">≈ ${qtyStr} unit(s) at $${formState.historicalPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} → now <strong style="color:var(--text)">$${currentVal.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong> · <span style="color:${gainColor}">${gain >= 0 ? "+" : ""}${gainPct.toFixed(2)}%</span></span>`;
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
  if (formState.currentLivePrice != null) {
    const currentVal = qty * formState.currentLivePrice;
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
