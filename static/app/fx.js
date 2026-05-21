// FX rate (USD → user currency). All monetary values are stored in USD
// on the backend; the frontend converts at display time using a live
// rate from /market/forex/USD/{currency}. Cached in localStorage with a
// 1h TTL so non-USD users don't wait for a yfinance round-trip on every
// cold start (FX moves slowly — ~0.5%/day for major pairs).
import { API, state } from "/static/app.js";

export async function loadFxRate() {
  const cur = state.user?.currency || "USD";
  if (cur === "USD") {
    state.fxRate = 1.0;
    state.fxFetchedAt = Date.now();
    state.fxFailed = false;
    return 1.0;
  }
  const lsKey = `fx:USD:${cur}`;
  try {
    const raw = localStorage.getItem(lsKey);
    if (raw) {
      const { rate, at } = JSON.parse(raw);
      if (isFinite(rate) && rate > 0 && Date.now() - at < 60 * 60 * 1000) {
        state.fxRate = rate;
        state.fxFetchedAt = at;
        state.fxFailed = false;
        // Background refresh — don't await, so the caller proceeds.
        API.request(`/market/forex/USD/${cur}`).then(d => {
          if (d?.rate && isFinite(d.rate) && d.rate > 0) {
            state.fxRate = d.rate;
            state.fxFetchedAt = Date.now();
            try { localStorage.setItem(lsKey, JSON.stringify({ rate: d.rate, at: Date.now() })); } catch (_) {}
          }
        }).catch(() => {});
        return rate;
      }
    }
  } catch (_) {}
  try {
    const data = await API.request(`/market/forex/USD/${cur}`);
    if (data?.rate && isFinite(data.rate) && data.rate > 0) {
      state.fxRate = data.rate;
      state.fxFetchedAt = Date.now();
      state.fxFailed = false;
      try { localStorage.setItem(lsKey, JSON.stringify({ rate: data.rate, at: Date.now() })); } catch (_) {}
      return data.rate;
    }
  } catch (e) {
    console.warn(`FX rate USD→${cur} failed, falling back to 1.0:`, e.message);
  }
  state.fxRate = 1.0;
  state.fxFailed = true;
  return 1.0;
}
