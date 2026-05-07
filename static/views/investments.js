import { API, money, pct, spinner, toast, escapeHtml } from "/static/app.js";
import { t } from "/static/i18n.js";

const TYPES = ["stock", "real_estate", "crypto", "bond", "etf", "startup"];

let cache = [];
let filterText = "";
let sortKey = "created_at";
let sortDir = -1;

export async function render(root) {
  root.innerHTML = `<div style="text-align:center;padding:40px">${spinner(true)}</div>`;
  try { cache = await API.request("/investments/"); }
  catch (err) { root.innerHTML = `<div class="alert-banner error">${err.message}</div>`; return; }

  root.innerHTML = `
    <div class="toolbar">
      <input id="inv-search" class="grow" placeholder="${t("investments.search_placeholder")}" />
      <button class="btn btn-primary" id="btn-add">+ ${t("investments.add")}</button>
      <label class="btn btn-ghost" for="csv-input">📥 ${t("investments.import_csv")}</label>
      <input id="csv-input" type="file" accept=".csv" hidden />
      <a class="btn btn-ghost" href="/exports/csv" target="_blank">📤 ${t("investments.export_csv")}</a>
    </div>
    <div class="card">
      ${cache.length ? renderTable(cache) : emptyState()}
    </div>
    <div id="modal-host"></div>
  `;

  document.getElementById("btn-add").onclick = () => openForm();
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
            <th data-sort="amount_invested">${t("investments.invested")}${tdir("amount_invested")}</th>
            <th data-sort="current_value">${t("investments.current")}${tdir("current_value")}</th>
            <th data-sort="purchase_date">${t("investments.purchase_date")}${tdir("purchase_date")}</th>
            <th data-sort="roi_pct">${t("investments.roi")}${tdir("roi_pct")}</th>
            <th>${t("investments.actions")}</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(r => `
            <tr>
              <td>${escapeHtml(r.name)}</td>
              <td>${t(`investments.types.${r.type}`)}</td>
              <td>${escapeHtml(r.symbol || "—")}</td>
              <td>${money(r.amount_invested)}</td>
              <td>${money(r.current_value)}</td>
              <td>${r.purchase_date}</td>
              <td><span class="badge ${badgeClass(r.roi_pct)}">${pct(r.roi_pct)}</span></td>
              <td>
                <button class="btn btn-ghost inv-edit" data-id="${r.id}">✎</button>
                <button class="btn btn-ghost inv-delete" data-id="${r.id}">🗑</button>
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
      <svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="3">
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

function openForm(id) {
  const inv = id ? cache.find(r => r.id === id) : null;
  const host = document.getElementById("modal-host");
  host.innerHTML = `
    <div class="auth-screen" style="position:fixed;inset:0;background:rgba(15,23,42,0.5);">
      <div class="auth-card">
        <h2>${inv ? t("investments.edit") : t("investments.add")}</h2>
        <form id="inv-form">
          <div class="field"><label>${t("investments.name")}</label><input name="name" required value="${inv ? escapeHtml(inv.name) : ""}"/></div>
          <div class="row">
            <div class="col field"><label>${t("investments.type")}</label>
              <select name="type">${TYPES.map(t2 => `<option value="${t2}" ${inv && inv.type === t2 ? "selected" : ""}>${t(`investments.types.${t2}`)}</option>`).join("")}</select>
            </div>
            <div class="col field"><label>${t("investments.symbol")}</label><input name="symbol" value="${inv ? escapeHtml(inv.symbol || "") : ""}"/></div>
          </div>
          <div class="row">
            <div class="col field"><label>${t("investments.invested")}</label><input name="amount_invested" type="number" step="0.01" min="0.01" required value="${inv ? inv.amount_invested : ""}"/></div>
            <div class="col field"><label>${t("investments.current")}</label><input name="current_value" type="number" step="0.01" min="0" required value="${inv ? inv.current_value : ""}"/></div>
          </div>
          <div class="field"><label>${t("investments.purchase_date")}</label><input name="purchase_date" type="date" required value="${inv ? inv.purchase_date : new Date().toISOString().slice(0, 10)}"/></div>
          <div class="field"><label>${t("investments.notes")}</label><textarea name="notes" rows="2">${inv ? escapeHtml(inv.notes || "") : ""}</textarea></div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-ghost" type="button" id="form-cancel">${t("investments.cancel")}</button>
            <button class="btn btn-primary" type="submit">${t("investments.save")}</button>
          </div>
        </form>
      </div>
    </div>`;
  document.getElementById("form-cancel").onclick = () => host.innerHTML = "";
  document.getElementById("inv-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const payload = Object.fromEntries(fd.entries());
    payload.amount_invested = parseFloat(payload.amount_invested);
    payload.current_value = parseFloat(payload.current_value);
    if (!payload.symbol) delete payload.symbol;
    if (!payload.notes) delete payload.notes;
    try {
      if (inv) await API.request(`/investments/${inv.id}`, { method: "PUT", body: payload });
      else await API.request("/investments/", { method: "POST", body: payload });
      toast(t("common.saved"), "success");
      host.innerHTML = "";
      cache = await API.request("/investments/");
      refresh(document);
    } catch (e) { toast(e.message, "error"); }
  };
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
