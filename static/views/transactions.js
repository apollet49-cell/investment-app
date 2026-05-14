import { API, state, money, pct, spinner, toast, escapeHtml, onViewCleanup } from "/static/app.js";
import { t } from "/static/i18n.js";

let cache = [];
let summary = null;
let investmentsCache = [];

export async function render(root) {
  root.innerHTML = `<div style="text-align:center;padding:40px">${spinner(true)}</div>`;
  try {
    const [txns, sum, invs] = await Promise.all([
      API.request("/transactions"),
      API.request("/transactions/summary"),
      API.request("/investments/"),
    ]);
    cache = txns;
    summary = sum;
    investmentsCache = invs;
  } catch (err) {
    root.innerHTML = `<div class="alert-banner error">${escapeHtml(err.message)}</div>`;
    return;
  }
  draw(root);
}

function draw(root) {
  const lifetime = summary?.lifetime || {};
  const ytd = summary?.ytd || {};
  root.innerHTML = `
    <div class="summary-grid">
      ${summaryCard(t("transactions.lifetime_buys"), money(lifetime.buy || 0))}
      ${summaryCard(t("transactions.lifetime_dividends"), money(lifetime.dividend || 0), "positive")}
      ${summaryCard(t("transactions.ytd_dividends"), money(ytd.dividend || 0), "positive")}
      ${summaryCard(t("transactions.total_count"), String(summary?.transaction_count || 0))}
    </div>

    <div style="height:14px"></div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px">
        <h3 style="margin:0">${t("transactions.title")}</h3>
        <button class="btn btn-primary" id="txn-add" ${investmentsCache.length === 0 ? "disabled" : ""}>+ ${t("transactions.add")}</button>
      </div>
      ${cache.length === 0
        ? `<div class="empty-state" style="padding:30px"><p>${t("transactions.empty")}</p></div>`
        : `<div class="table-wrap"><table class="data">
            <thead><tr>
              <th>${t("transactions.col_date")}</th>
              <th>${t("transactions.col_type")}</th>
              <th>${t("transactions.col_investment")}</th>
              <th style="text-align:right">${t("transactions.col_qty")}</th>
              <th style="text-align:right">${t("transactions.col_price")}</th>
              <th style="text-align:right">${t("transactions.col_amount")}</th>
              <th>${t("transactions.col_notes")}</th>
              <th></th>
            </tr></thead>
            <tbody>${cache.map(rowHtml).join("")}</tbody>
          </table></div>`}
    </div>

    <div id="txn-modal-host"></div>
  `;

  const addBtn = document.getElementById("txn-add");
  if (addBtn) addBtn.onclick = () => openAddModal(root);
  for (const b of root.querySelectorAll(".txn-del")) {
    b.onclick = () => deleteTxn(parseInt(b.dataset.id, 10), root);
  }
}

function rowHtml(tx) {
  const typeColor = {
    buy: "var(--success)", sell: "var(--warning)",
    dividend: "var(--primary)", fee: "var(--danger)", split: "var(--text-muted)",
  }[tx.type] || "var(--text-muted)";
  return `<tr>
    <td>${tx.transaction_date || "—"}</td>
    <td><span class="badge" style="background:rgba(138,117,88,0.12);color:${typeColor};text-transform:uppercase;font-size:10px">${tx.type}</span></td>
    <td>${escapeHtml(tx.investment_name || "—")}</td>
    <td style="text-align:right;font-variant-numeric:tabular-nums">${tx.quantity != null ? Number(tx.quantity).toLocaleString(undefined, { maximumFractionDigits: 8 }) : "—"}</td>
    <td style="text-align:right;font-variant-numeric:tabular-nums">${tx.price_per_unit != null ? money(Number(tx.price_per_unit)) : "—"}</td>
    <td style="text-align:right"><strong>${money(tx.amount)}</strong>${tx.fees ? `<div style="color:var(--text-muted);font-size:10px">fees ${money(tx.fees)}</div>` : ""}</td>
    <td style="color:var(--text-muted);font-size:12px;max-width:200px">${escapeHtml(tx.notes || "")}</td>
    <td><button class="btn btn-ghost txn-del" data-id="${tx.id}" title="${t("transactions.delete")}">×</button></td>
  </tr>`;
}

function summaryCard(label, value, cls = "") {
  return `<div class="summary-card"><div class="label">${label}</div><div class="value ${cls}" style="font-size:24px">${value}</div></div>`;
}

function openAddModal(root) {
  const today = new Date().toISOString().slice(0, 10);
  const host = document.getElementById("txn-modal-host");
  host.innerHTML = `
    <div class="modal-overlay" id="txn-overlay">
      <div class="modal-panel">
        <div class="modal-header">
          <strong>${t("transactions.add")}</strong>
          <button class="icon-btn" id="txn-close">×</button>
        </div>
        <div class="modal-body">
          <form id="txn-form">
            <div class="row">
              <div class="col field"><label>${t("transactions.col_investment")}</label>
                <select name="investment_id" required>
                  ${investmentsCache.map(i => `<option value="${i.id}">${escapeHtml(i.name)} (${escapeHtml(i.symbol || i.type)})</option>`).join("")}
                </select></div>
              <div class="col field"><label>${t("transactions.col_type")}</label>
                <select name="type" required>
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                  <option value="dividend">Dividend</option>
                  <option value="fee">Fee</option>
                  <option value="split">Split</option>
                </select></div>
              <div class="col field"><label>${t("transactions.col_date")}</label>
                <input name="transaction_date" type="date" required value="${today}"/></div>
            </div>
            <div class="row">
              <div class="col field"><label>${t("transactions.col_qty")}</label>
                <input name="quantity" type="number" step="any" min="0" placeholder="—"/></div>
              <div class="col field"><label>${t("transactions.col_price")} (USD)</label>
                <input name="price_per_unit" type="number" step="any" min="0" placeholder="—"/></div>
              <div class="col field"><label>${t("transactions.col_amount")} (USD) *</label>
                <input name="amount" type="number" step="0.01" min="0.01" required/></div>
            </div>
            <div class="row">
              <div class="col field"><label>${t("transactions.col_fees")} (USD)</label>
                <input name="fees" type="number" step="0.01" min="0" placeholder="0"/></div>
              <div class="col field" style="flex:2"><label>${t("transactions.col_notes")}</label>
                <input name="notes" placeholder="—"/></div>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
              <button class="btn btn-ghost" type="button" id="txn-cancel">${t("common.cancel")}</button>
              <button class="btn btn-primary" type="submit">${t("common.save")}</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;
  document.getElementById("txn-close").onclick = closeModal;
  document.getElementById("txn-cancel").onclick = closeModal;
  document.getElementById("txn-overlay").onclick = (ev) => { if (ev.target.id === "txn-overlay") closeModal(); };
  // Auto-fill amount when qty + price are entered
  const qtyEl = document.querySelector('input[name="quantity"]');
  const ppuEl = document.querySelector('input[name="price_per_unit"]');
  const amountEl = document.querySelector('input[name="amount"]');
  const recomputeAmount = () => {
    const q = parseFloat(qtyEl.value);
    const p = parseFloat(ppuEl.value);
    if (isFinite(q) && isFinite(p) && q > 0 && p > 0 && !amountEl.dataset.userTyped) {
      amountEl.value = (q * p).toFixed(2);
    }
  };
  qtyEl.oninput = recomputeAmount;
  ppuEl.oninput = recomputeAmount;
  amountEl.oninput = () => { amountEl.dataset.userTyped = "true"; };

  document.getElementById("txn-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const invId = parseInt(fd.get("investment_id"), 10);
    const body = {
      type: fd.get("type"),
      transaction_date: fd.get("transaction_date"),
      quantity: parseFloat(fd.get("quantity")) || null,
      price_per_unit: parseFloat(fd.get("price_per_unit")) || null,
      amount: parseFloat(fd.get("amount")),
      fees: parseFloat(fd.get("fees")) || null,
      notes: (fd.get("notes") || "").toString().trim() || null,
    };
    try {
      await API.request(`/investments/${invId}/transactions`, { method: "POST", body });
      toast(t("common.saved"), "success");
      closeModal();
      await render(root);
    } catch (e) { toast(e.message, "error"); }
  };
}

async function deleteTxn(id, root) {
  if (!confirm(t("transactions.confirm_delete"))) return;
  try {
    await API.request(`/transactions/${id}`, { method: "DELETE" });
    toast(t("common.deleted"), "success");
    await render(root);
  } catch (e) { toast(e.message, "error"); }
}

function closeModal() {
  document.getElementById("txn-modal-host").innerHTML = "";
}
