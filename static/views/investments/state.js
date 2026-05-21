// Mutable state shared between the investments table, the add/edit form,
// the asset picker, and the calc helpers. Each opens the same modal and
// touches the same "current pick / current price" trio, so a tiny module
// of public mutable refs beats threading callbacks through six files.

export const TYPES = ["stock", "real_estate", "crypto", "bond", "etf", "startup"];
export const UNIT_CAPABLE_TYPES = new Set(["stock", "etf", "crypto"]);

// Table state (cache + filters + sort). investments.js is the only writer
// for cache and the only one that calls refresh(); the form module reads
// cache to look up "the investment being edited" and replaces the entry
// after save / delete completes.
export const tableState = {
  cache: [],
  filterText: "",
  filterType: "all",
  sortKey: "created_at",
  sortDir: -1,
};

// Form state: which asset is currently picked, plus its live + purchase-date
// prices. Reset to null in closeModal() so a stale pick from yesterday's
// session doesn't bleed into the next "add investment" click.
export const formState = {
  pickedAsset: null,        // { id, symbol, type } from the catalogue
  currentLivePrice: null,   // USD per unit, right now
  historicalPrice: null,    // USD per unit, on the chosen purchase date
  histPriceTimer: null,     // debounce timer for purchase_date → price fetch
};

export function resetFormState() {
  formState.pickedAsset = null;
  formState.currentLivePrice = null;
  formState.historicalPrice = null;
}

export function badgeClass(roi) {
  if (roi >= 5) return "green";
  if (roi <= -5) return "red";
  return "yellow";
}
