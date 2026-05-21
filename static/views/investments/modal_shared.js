// Modal chrome shared by all three investments modals (form, what-if,
// detail): the overlay/panel CSS, the close helper, and the CSV import +
// delete actions that are wired from the table.
import { API, confirmModal, escapeHtml, invalidateCache, state, toast } from "/static/app.js";
import { t } from "/static/i18n.js";

import { resetFormState, tableState } from "./state.js";

export function closeModal() {
  document.getElementById("modal-host").innerHTML = "";
  // Reset the per-form state so the next open starts fresh.
  resetFormState();
}

export async function deleteInv(id, root, refresh) {
  const ok = await confirmModal({
    title: t("common.confirm") || "Confirm",
    message: t("investments.confirm_delete"),
    confirmText: t("common.delete") || "Delete",
    cancelText: t("common.cancel") || "Cancel",
    danger: true,
  });
  if (!ok) return;
  // Optimistic delete: pull the row out of the local cache + UI
  // immediately so the action feels instant. If the API call fails,
  // we restore the row and surface a toast. The cache invalidation
  // happens after the API call returns so concurrent navigation
  // doesn't read a torn state.
  const snapshot = tableState.cache;
  tableState.cache = tableState.cache.filter(r => r.id !== id);
  refresh(root);
  try {
    await API.request(`/investments/${id}`, { method: "DELETE" });
    invalidateCache("/investments/", "/dashboard/");
    try { sessionStorage.setItem(`swr:${state.token?.slice(-12) || "anon"}:/investments/`, JSON.stringify(tableState.cache)); } catch (_) {}
    toast(t("common.deleted"), "success");
  } catch (e) {
    tableState.cache = snapshot;
    refresh(root);
    toast(`${t("common.error_generic")} — ${escapeHtml(e.message)}`, "error");
  }
}

export async function onCsvUpload(ev, refresh) {
  const f = ev.target.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append("file", f);
  try {
    const res = await API.request("/investments/import", { method: "POST", body: fd });
    toast(`Imported ${res.imported}, skipped ${res.skipped}`, res.skipped ? "info" : "success");
    if (res.errors.length) console.warn("CSV import errors:", res.errors);
    tableState.cache = await API.request("/investments/");
    invalidateCache("/investments/", "/dashboard/");
    try { sessionStorage.setItem(`swr:${state.token?.slice(-12) || "anon"}:/investments/`, JSON.stringify(tableState.cache)); } catch (_) {}
    refresh(document);
  } catch (e) { toast(e.message, "error"); }
  ev.target.value = "";
}

export function injectModalStyles() {
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
