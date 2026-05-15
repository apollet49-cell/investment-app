import { API, loadChartJs, money, pct, spinner, toast, state, escapeHtml } from "/static/app.js";
import { t } from "/static/i18n.js";

const RISKS = ["low", "medium", "high"];

export async function render(root) {
  root.innerHTML = `<div style="text-align:center;padding:40px">${spinner(true)}</div>`;
  let scenarios;
  try { scenarios = await API.request("/scenarios/"); }
  catch (err) { root.innerHTML = `<div class="alert-banner error">${escapeHtml(err.message)}</div>`; return; }

  root.innerHTML = `
    <div class="card">
      <h3>${t("scenarios.create")}</h3>
      <form id="sc-form">
        <div class="row">
          <div class="col field"><label>${t("scenarios.name")}</label><input name="name" required/></div>
          <div class="col field"><label>${t("scenarios.amount")}</label><input name="amount" type="number" min="1" step="0.01" required/></div>
          <div class="col field"><label>${t("scenarios.horizon_months")}</label><input name="horizon_months" type="number" min="1" max="600" required value="60"/></div>
        </div>
        <div class="row">
          <div class="col field"><label>${t("scenarios.annual_return")}</label><input name="annual_return" type="number" step="0.01" required value="7"/></div>
          <div class="col field"><label>${t("scenarios.inflation_rate")}</label><input name="inflation_rate" type="number" step="0.01" required value="2"/></div>
          <div class="col field"><label>${t("scenarios.risk_level")}</label>
            <select name="risk_level">${RISKS.map(r => `<option value="${r}">${t(`scenarios.risk.${r}`)}</option>`).join("")}</select>
          </div>
        </div>
        <button class="btn btn-primary" type="submit">${t("scenarios.save")}</button>
      </form>
    </div>
    <div style="height:16px"></div>
    <div id="sc-list"></div>
  `;

  document.getElementById("sc-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const payload = Object.fromEntries(fd.entries());
    ["amount", "horizon_months", "annual_return", "inflation_rate"].forEach(k => payload[k] = parseFloat(payload[k]));
    payload.horizon_months = parseInt(payload.horizon_months, 10);
    try {
      await API.request("/scenarios/", { method: "POST", body: payload });
      toast(t("common.saved"), "success");
      ev.target.reset();
      const refreshed = await API.request("/scenarios/");
      renderList(refreshed);
    } catch (e) { toast(e.message, "error"); }
  };

  renderList(scenarios);
}

function renderList(scenarios) {
  const host = document.getElementById("sc-list");
  if (!scenarios.length) {
    host.innerHTML = `<div class="card empty-state"><h3>${t("scenarios.empty_title")}</h3><p>${t("scenarios.empty_sub")}</p></div>`;
    return;
  }
  host.innerHTML = `
    <div class="card">
      <h3>${t("scenarios.compare")}</h3>
      <div class="table-wrap"><table class="data">
        <thead><tr>
          <th>${t("scenarios.name")}</th>
          <th>${t("scenarios.amount")}</th>
          <th>${t("scenarios.horizon_months")}</th>
          <th>${t("scenarios.annual_return")}</th>
          <th>${t("scenarios.risk_level")}</th>
          <th>${t("investments.actions")}</th>
        </tr></thead>
        <tbody>
          ${scenarios.map(s => `<tr>
            <td>${escapeHtml(s.name)}</td>
            <td>${money(s.amount)}</td>
            <td>${s.horizon_months}</td>
            <td>${pct(s.annual_return)}</td>
            <td>${t(`scenarios.risk.${s.risk_level}`)}</td>
            <td>
              <button class="btn btn-primary sc-sim" data-id="${s.id}">${t("scenarios.simulate")}</button>
              <button class="btn btn-ghost sc-del" data-id="${s.id}">🗑</button>
            </td>
          </tr>`).join("")}
        </tbody>
      </table></div>
    </div>
    <div id="sim-host" style="margin-top:16px"></div>
  `;
  for (const b of host.querySelectorAll(".sc-sim")) b.onclick = () => simulate(parseInt(b.dataset.id, 10), scenarios);
  for (const b of host.querySelectorAll(".sc-del")) b.onclick = () => delScenario(parseInt(b.dataset.id, 10));
}

async function delScenario(id) {
  if (!confirm("Delete?")) return;
  try {
    await API.request(`/scenarios/${id}`, { method: "DELETE" });
    const refreshed = await API.request("/scenarios/");
    renderList(refreshed);
  } catch (e) { toast(e.message, "error"); }
}

async function simulate(id) {
  const host = document.getElementById("sim-host");
  host.innerHTML = `<div class="card" style="text-align:center;padding:30px">${spinner(true)}</div>`;
  try {
    const sim = await API.request(`/scenarios/${id}/simulate`);
    host.innerHTML = `
      <div class="card">
        <h3>${escapeHtml(sim.scenario.name)}</h3>
        <div class="row">
          ${subCard(sim.pessimistic, "red")}
          ${subCard(sim.realistic, "yellow")}
          ${subCard(sim.optimistic, "green")}
        </div>
        <div style="margin-top:12px"><strong>${t("scenarios.recommendation")}:</strong> ${escapeHtml(sim.recommendation)}</div>
        <canvas id="sc-chart" height="120" style="margin-top:16px"></canvas>
      </div>`;
    drawChart(sim);
  } catch (e) { host.innerHTML = `<div class="alert-banner error">${escapeHtml(e.message)}</div>`; }
}

function subCard(sub, color) {
  return `<div class="col"><div class="card" style="border-left:2px solid var(--${color === "red" ? "danger" : color === "green" ? "success" : "warning"})">
    <strong style="font-family:var(--font-serif);font-size:18px;font-weight:500">${t(`scenarios.${sub.label.toLowerCase()}`)}</strong>
    <div style="font-family:var(--font-serif);font-size:28px;font-weight:400;margin-top:8px">${money(sub.final_value)}</div>
    <div style="color:var(--text-muted);font-size:12px;margin-top:4px">${t("scenarios.final_value_real")}: ${money(sub.final_value_real)}</div>
    <div style="color:var(--text-muted);font-size:12px">${t("scenarios.annual_return")}: ${pct(sub.annual_return)}</div>
  </div></div>`;
}

async function drawChart(sim) {
  const ctx = document.getElementById("sc-chart");
  if (!ctx) return;
  await loadChartJs();
  if (!document.getElementById("sc-chart")) return;
  try { state.charts.scenario?.destroy?.(); } catch (_) {}
  state.charts.scenario = new window.Chart(ctx, {
    type: "line",
    data: {
      labels: sim.realistic.points.map(p => p.month),
      datasets: [
        { label: t("scenarios.pessimistic"), data: sim.pessimistic.points.map(p => p.value), borderColor: "#a56551", borderWidth: 1.5, tension: 0.2, pointRadius: 0 },
        { label: t("scenarios.realistic"),   data: sim.realistic.points.map(p => p.value), borderColor: "#b8945e", borderWidth: 1.5, tension: 0.2, pointRadius: 0 },
        { label: t("scenarios.optimistic"),  data: sim.optimistic.points.map(p => p.value), borderColor: "#6b7d5e", borderWidth: 1.5, tension: 0.2, pointRadius: 0 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false },
  });
}
