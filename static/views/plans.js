import { API, loadChartJs, state, money, spinner, toast, escapeHtml, onViewCleanup } from "/static/app.js";
import { t } from "/static/i18n.js";

let dcaCache = [];
let activeSimulation = null;  // {planId, data}

export async function render(root) {
  root.innerHTML = `<div style="text-align:center;padding:40px">${spinner(true)}</div>`;
  try { dcaCache = await API.request("/plans/dca"); }
  catch (err) {
    root.innerHTML = `<div class="alert-banner error">${escapeHtml(err.message)}</div>`;
    return;
  }
  draw(root);
}

function draw(root) {
  root.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">${t("plans.dca_title")}</h3>
      <p style="color:var(--text-muted);font-size:13px;margin:0 0 14px">${t("plans.dca_subtitle")}</p>
      <button class="btn btn-primary" id="dca-add">+ ${t("plans.new_plan")}</button>
    </div>

    <div style="height:14px"></div>

    ${dcaCache.length === 0
      ? `<div class="card empty-state"><h3>${t("plans.empty_title")}</h3><p>${t("plans.empty_sub")}</p></div>`
      : `<div class="card">
          <div class="table-wrap"><table class="data">
            <thead><tr>
              <th>${t("plans.col_name")}</th>
              <th>${t("plans.col_symbol")}</th>
              <th>${t("plans.col_amount")}</th>
              <th>${t("plans.col_frequency")}</th>
              <th>${t("plans.col_start")}</th>
              <th>${t("plans.col_status")}</th>
              <th></th>
            </tr></thead>
            <tbody>
              ${dcaCache.map(p => `<tr>
                <td><strong>${escapeHtml(p.name)}</strong></td>
                <td>${escapeHtml(p.symbol || "—")} <span style="color:var(--text-muted);font-size:11px">${escapeHtml(p.asset_type)}</span></td>
                <td>${money(p.amount)}</td>
                <td>${escapeHtml(p.frequency)}</td>
                <td>${p.start_date}</td>
                <td>${p.is_active ? `<span class="badge green">${t("plans.active")}</span>` : `<span class="badge gray">${t("plans.paused")}</span>`}</td>
                <td>
                  <button class="btn btn-ghost dca-sim" data-id="${p.id}">${t("plans.simulate")}</button>
                  <button class="btn btn-ghost dca-del" data-id="${p.id}">×</button>
                </td>
              </tr>`).join("")}
            </tbody>
          </table></div>
        </div>`}

    <div style="height:14px"></div>
    <div id="sim-host"></div>
    <div id="plan-modal-host"></div>
  `;

  document.getElementById("dca-add").onclick = () => openCreateModal(root);
  for (const b of root.querySelectorAll(".dca-sim")) {
    b.onclick = () => simulate(parseInt(b.dataset.id, 10), root);
  }
  for (const b of root.querySelectorAll(".dca-del")) {
    b.onclick = () => deletePlan(parseInt(b.dataset.id, 10), root);
  }
}

function openCreateModal(root) {
  const today = new Date().toISOString().slice(0, 10);
  const host = document.getElementById("plan-modal-host");
  host.innerHTML = `
    <div class="modal-overlay" id="plan-overlay">
      <div class="modal-panel">
        <div class="modal-header">
          <strong>${t("plans.new_plan")}</strong>
          <button class="icon-btn" id="plan-close">×</button>
        </div>
        <div class="modal-body">
          <form id="dca-form">
            <div class="field"><label>${t("plans.col_name")} *</label>
              <input name="name" required placeholder="e.g. VWCE monthly"/></div>
            <div class="row">
              <div class="col field"><label>${t("plans.col_symbol")}</label>
                <input name="symbol" placeholder="VWCE.DE"/></div>
              <div class="col field"><label>Type</label>
                <select name="asset_type">
                  <option value="etf">ETF</option>
                  <option value="stock">Stock</option>
                  <option value="crypto">Crypto</option>
                </select></div>
            </div>
            <div class="row">
              <div class="col field"><label>${t("plans.col_amount")} (USD) *</label>
                <input name="amount" type="number" step="0.01" min="1" required placeholder="200"/></div>
              <div class="col field"><label>${t("plans.col_frequency")}</label>
                <select name="frequency">
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Bi-weekly</option>
                  <option value="monthly" selected>Monthly</option>
                  <option value="quarterly">Quarterly</option>
                </select></div>
              <div class="col field"><label>${t("plans.col_start")}</label>
                <input name="start_date" type="date" required value="${today}"/></div>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
              <button class="btn btn-ghost" type="button" id="plan-cancel">${t("common.cancel")}</button>
              <button class="btn btn-primary" type="submit">${t("common.save")}</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;
  const close = () => { host.innerHTML = ""; };
  document.getElementById("plan-close").onclick = close;
  document.getElementById("plan-cancel").onclick = close;
  document.getElementById("plan-overlay").onclick = (ev) => { if (ev.target.id === "plan-overlay") close(); };
  document.getElementById("dca-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const body = {
      name: fd.get("name"),
      symbol: (fd.get("symbol") || "").toString().trim() || null,
      asset_type: fd.get("asset_type"),
      amount: parseFloat(fd.get("amount")),
      frequency: fd.get("frequency"),
      start_date: fd.get("start_date"),
      is_active: true,
    };
    try {
      await API.request("/plans/dca", { method: "POST", body });
      toast(t("common.saved"), "success");
      close();
      await render(root);
    } catch (e) { toast(e.message, "error"); }
  };
}

async function simulate(planId, root) {
  const host = document.getElementById("sim-host");
  host.innerHTML = `<div class="card" style="text-align:center;padding:20px">${spinner()}</div>`;
  try {
    const data = await API.request(`/plans/dca/${planId}/simulate?years=10&expected_return_pct=7`);
    const plan = data.plan;
    const dcaFinal = data.final_value_dca;
    const lumpFinal = data.final_value_lump_sum;
    const delta = data.dca_minus_lump;
    const total = data.total_contributed;
    host.innerHTML = `
      <div class="card">
        <h3 style="margin-top:0">${t("plans.simulation_for", { name: escapeHtml(plan.name) })}</h3>
        <div style="color:var(--text-muted);font-size:13px;margin-bottom:14px">${t("plans.simulation_caption", { years: data.years, ret: data.expected_return_pct })}</div>
        <div class="summary-grid">
          ${kpi(t("plans.total_contributed"), money(total))}
          ${kpi(t("plans.final_dca"), money(dcaFinal), "positive")}
          ${kpi(t("plans.final_lump_sum"), money(lumpFinal))}
          ${kpi(t("plans.dca_minus_lump"), money(delta), delta >= 0 ? "positive" : "negative")}
        </div>
        <div class="chart-canvas-wrap" style="height:300px;margin-top:14px"><canvas id="sim-chart"></canvas></div>
      </div>`;
    drawSimChart(data);
  } catch (e) { host.innerHTML = `<div class="alert-banner error">${escapeHtml(e.message)}</div>`; }
}

function kpi(label, value, cls = "") {
  return `<div class="summary-card"><div class="label">${label}</div><div class="value ${cls}" style="font-size:22px">${value}</div></div>`;
}

async function drawSimChart(data) {
  const ctx = document.getElementById("sim-chart");
  if (!ctx) return;
  await loadChartJs();
  if (!document.getElementById("sim-chart")) return;
  if (state.charts.sim) { try { state.charts.sim.destroy(); } catch (_) {} }
  state.charts.sim = new window.Chart(ctx, {
    type: "line",
    data: {
      labels: data.trajectory_dca.map(p => `P${p.period}`),
      datasets: [
        {
          label: t("plans.dca_curve"),
          data: data.trajectory_dca.map(p => p.value),
          borderColor: "#8a7558",
          backgroundColor: "rgba(138,117,88,0.08)",
          fill: true, tension: 0.2, borderWidth: 1.5, pointRadius: 0,
        },
        {
          label: t("plans.lump_curve"),
          data: data.trajectory_lump_sum.map(p => p.value),
          borderColor: "#6b7d5e",
          borderWidth: 1.5, tension: 0.2, pointRadius: 0,
        },
        {
          label: t("plans.contributed_curve"),
          data: data.trajectory_dca.map(p => p.contributed),
          borderColor: "#a89683",
          borderDash: [4, 4],
          borderWidth: 1, tension: 0.2, pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom" } },
      scales: { y: { beginAtZero: true } },
    },
  });
}

async function deletePlan(id, root) {
  if (!confirm("Delete this plan?")) return;
  try {
    await API.request(`/plans/dca/${id}`, { method: "DELETE" });
    toast(t("common.deleted"), "success");
    await render(root);
  } catch (e) { toast(e.message, "error"); }
}
