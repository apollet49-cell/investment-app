// Asset catalogue picker: typeahead search → fetch live + historical price
// → write everything into the open form. Sits between the user typing
// "AAPL" and the form having a valid {symbol, type, currentLivePrice,
// historicalPrice} tuple ready for save.
import { API, escapeHtml, spinner } from "/static/app.js";

import { TYPES, formState } from "./state.js";
import { fetchHistoricalPrice, recomputeCurrentValues } from "./form_inputs.js";

let assetSearchTimer = null;

export function setupAssetPicker() {
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
    const data = await API.request(`/market/search?q=${encodeURIComponent(q)}&limit=8`);
    if (!data.results || !data.results.length) {
      results.innerHTML = `<div class="asset-empty">— or enter manually —</div>`;
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

// Build a synthetic "asset row" from an existing Investment and feed it
// to pickAsset(), so opening the edit modal re-fetches current + historical
// prices without the user having to re-search the catalogue.
export async function autoPickFromExisting(inv) {
  if (!inv || !inv.symbol) return;
  let coingeckoId = "";
  // Heuristic: a crypto whose symbol has no dash (e.g. "bitcoin") is likely
  // a CoinGecko id from the local catalogue. Symbols like "BTC-USD" are
  // yfinance tickers and should hit the yfinance path.
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
  formState.pickedAsset = { id: id || null, symbol: sym, type: normType };
  formState.currentLivePrice = null;
  formState.historicalPrice = null;

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
      formState.currentLivePrice = price;
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
