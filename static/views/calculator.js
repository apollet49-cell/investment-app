import { API, toast, spinner } from "/static/app.js";
import { t } from "/static/i18n.js";

const FIELDS = {
  roi:        { method: "GET", path: "/calculator/roi", fields: [["initial", "number"], ["final", "number"]] },
  compound:   { method: "GET", path: "/calculator/compound", fields: [["principal", "number"], ["annual_rate_pct", "number"], ["years", "number"], ["compounds_per_year", "number", 12]] },
  cagr:       { method: "GET", path: "/calculator/cagr", fields: [["beginning", "number"], ["ending", "number"], ["years", "number"]] },
  npv:        { method: "POST", path: "/calculator/npv", fields: [["rate_pct", "number"], ["cashflows", "csv"]] },
  irr:        { method: "POST", path: "/calculator/irr", fields: [["cashflows", "csv"]] },
  sharpe:     { method: "POST", path: "/calculator/sharpe", fields: [["cashflows", "csv"], ["risk_free_rate", "number", 0.02]], renamed: { cashflows: "cashflows", risk_free_rate: "risk_free_rate" } },
  payback:    { method: "GET", path: "/calculator/payback", fields: [["initial_investment", "number"], ["annual_cash_flow", "number"]] },
  breakeven:  { method: "GET", path: "/calculator/breakeven", fields: [["fixed_costs", "number"], ["price_per_unit", "number"], ["variable_cost_per_unit", "number"]] },
  annualized: { method: "GET", path: "/calculator/annualized", fields: [["total_return_pct", "number"], ["days", "number"]] },
};

let mode = "roi";

export async function render(root) {
  root.innerHTML = `
    <div class="card">
      <div class="field">
        <label>${t("calculator.mode")}</label>
        <select id="calc-mode">
          ${Object.keys(FIELDS).map(m => `<option value="${m}">${t(`calculator.modes.${m}`)}</option>`).join("")}
        </select>
      </div>
      <div id="calc-fields"></div>
      <button class="btn btn-primary" id="calc-run">${t("calculator.calculate")}</button>
      <div id="calc-output"></div>
    </div>`;
  const sel = document.getElementById("calc-mode");
  sel.value = mode;
  sel.onchange = () => { mode = sel.value; renderFields(); document.getElementById("calc-output").innerHTML = ""; };
  renderFields();
  document.getElementById("calc-run").onclick = run;
}

function renderFields() {
  const cfg = FIELDS[mode];
  const host = document.getElementById("calc-fields");
  host.innerHTML = cfg.fields.map(([name, type, def]) => {
    if (type === "csv") {
      return `<div class="field"><label>${t("calculator." + name) || name}</label>
        <input data-name="${name}" data-kind="csv" placeholder="-1000, 300, 400, 500" value="${def ?? ""}"/></div>`;
    }
    return `<div class="field"><label>${t("calculator." + name) || name}</label>
      <input data-name="${name}" data-kind="number" type="number" step="any" value="${def ?? ""}"/></div>`;
  }).join("");
}

async function run() {
  const cfg = FIELDS[mode];
  const inputs = {};
  for (const el of document.querySelectorAll("#calc-fields [data-name]")) {
    if (el.dataset.kind === "csv") {
      const arr = el.value.split(",").map(s => parseFloat(s.trim())).filter(v => !Number.isNaN(v));
      if (!arr.length) { toast("cashflows required", "error"); return; }
      inputs[el.dataset.name] = arr;
    } else {
      const v = parseFloat(el.value);
      if (Number.isNaN(v)) { toast(`${el.dataset.name} required`, "error"); return; }
      inputs[el.dataset.name] = v;
    }
  }
  const out = document.getElementById("calc-output");
  out.innerHTML = `<div style="text-align:center;padding:16px">${spinner()}</div>`;
  try {
    let res;
    if (cfg.method === "POST") {
      res = await API.request(cfg.path, { method: "POST", body: inputs });
    } else {
      const qs = new URLSearchParams(Object.entries(inputs).map(([k, v]) => [k, String(v)])).toString();
      res = await API.request(`${cfg.path}?${qs}`);
    }
    out.innerHTML = `
      <div class="calc-result">
        <div class="result">${formatResult(res.result)}</div>
        <div class="formula">${t("calculator.formula")}: ${res.formula}</div>
        <details open><summary>${t("calculator.steps")}</summary>
          <ol class="steps">${res.steps.map(s => `<li>${s}</li>`).join("")}</ol>
        </details>
      </div>`;
  } catch (e) {
    out.innerHTML = `<div class="alert-banner error">${e.message}</div>`;
  }
}

function formatResult(r) {
  if (typeof r === "number") return Number.isInteger(r) ? r.toString() : r.toFixed(4);
  return JSON.stringify(r);
}
