import { toast, escapeHtml } from "/static/app.js";
import { t } from "/static/i18n.js";

// All eight calculators run entirely in the browser. The previous version
// did one fetch per "Calculate" click (≈200-500ms round-trip on Render free
// tier). The math is trivial and runs in <1ms locally, so results feel
// instant. The Python equivalents in services/calculator.py still exist
// for the test suite and any future programmatic callers.

const FIELDS = {
  roi:        { fields: [["initial", "number"], ["final", "number"]] },
  compound:   { fields: [["principal", "number"], ["annual_rate_pct", "number"], ["years", "number"], ["compounds_per_year", "number", 12]] },
  cagr:       { fields: [["beginning", "number"], ["ending", "number"], ["years", "number"]] },
  npv:        { fields: [["rate_pct", "number"], ["cashflows", "csv"]] },
  irr:        { fields: [["cashflows", "csv"]] },
  sharpe:     { fields: [["cashflows", "csv"], ["risk_free_rate", "number", 0.02]] },
  payback:    { fields: [["initial_investment", "number"], ["annual_cash_flow", "number"]] },
  breakeven:  { fields: [["fixed_costs", "number"], ["price_per_unit", "number"], ["variable_cost_per_unit", "number"]] },
  annualized: { fields: [["total_return_pct", "number"], ["days", "number"]] },
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
  sel.onchange = () => {
    mode = sel.value;
    renderFields();
    document.getElementById("calc-output").innerHTML = "";
    runLive();
  };
  renderFields();
  document.getElementById("calc-run").onclick = run;

  // Live updates: every input change recomputes instantly (debounced 50ms
  // to coalesce keyboard mash). If any input is missing/invalid, the
  // output is cleared rather than showing a stale result.
  let debounce = null;
  document.getElementById("calc-fields").addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(runLive, 50);
  });
  runLive();
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

function readInputs() {
  const inputs = {};
  for (const el of document.querySelectorAll("#calc-fields [data-name]")) {
    if (el.dataset.kind === "csv") {
      const arr = el.value.split(",").map(s => parseFloat(s.trim())).filter(v => !Number.isNaN(v));
      if (!arr.length) return null;
      inputs[el.dataset.name] = arr;
    } else {
      const v = parseFloat(el.value);
      if (Number.isNaN(v)) return null;
      inputs[el.dataset.name] = v;
    }
  }
  return inputs;
}

function runLive() {
  const inputs = readInputs();
  const out = document.getElementById("calc-output");
  if (!out) return;
  if (!inputs) { out.innerHTML = ""; return; }
  try {
    const res = compute(mode, inputs);
    renderResult(out, res);
  } catch (_) {
    // Silent on live-update path: bad inputs just clear the output. The
    // explicit Calculate button surfaces the error via toast.
    out.innerHTML = "";
  }
}

async function run() {
  const inputs = readInputs();
  if (!inputs) { toast(t("calculator.fields_required") || "All fields required", "error"); return; }
  const out = document.getElementById("calc-output");
  try {
    const res = compute(mode, inputs);
    renderResult(out, res);
  } catch (e) {
    out.innerHTML = `<div class="alert-banner error">${escapeHtml(e.message)}</div>`;
  }
}

function renderResult(out, res) {
  out.innerHTML = `
    <div class="calc-result">
      <div class="result">${formatResult(res.result)}</div>
      <div class="formula">${t("calculator.formula")}: ${escapeHtml(res.formula)}</div>
      <details open><summary>${t("calculator.steps")}</summary>
        <ol class="steps">${res.steps.map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
      </details>
    </div>`;
}

function formatResult(r) {
  if (r === null || r === undefined) return "—";
  if (typeof r === "number") return Number.isInteger(r) ? r.toString() : r.toFixed(4);
  return JSON.stringify(r);
}

// ---------- Pure math (matches services/calculator.py exactly) ----------

function fmt(n, d = 6) {
  if (!isFinite(n)) return String(n);
  return Number(n).toFixed(d);
}

function compute(m, i) {
  switch (m) {
    case "roi": return calcRoi(i.initial, i.final);
    case "compound": return calcCompound(i.principal, i.annual_rate_pct, i.years, i.compounds_per_year || 12);
    case "cagr": return calcCagr(i.beginning, i.ending, i.years);
    case "npv": return calcNpv(i.rate_pct, i.cashflows);
    case "irr": return calcIrr(i.cashflows);
    case "sharpe": return calcSharpe(i.cashflows, i.risk_free_rate ?? 0.02);
    case "payback": return calcPayback(i.initial_investment, i.annual_cash_flow);
    case "breakeven": return calcBreakeven(i.fixed_costs, i.price_per_unit, i.variable_cost_per_unit);
    case "annualized": return calcAnnualized(i.total_return_pct, i.days);
    default: throw new Error(`Unknown mode: ${m}`);
  }
}

function ensurePositive(name, v) {
  if (v === null || v === undefined || v <= 0) throw new Error(`${name} must be greater than 0`);
}

function calcRoi(initial, final) {
  ensurePositive("initial", initial);
  if (final < 0) throw new Error("final must be >= 0");
  const roi = ((final - initial) / initial) * 100;
  return {
    formula: "ROI % = (final − initial) / initial × 100",
    steps: [
      `final − initial = ${final} − ${initial} = ${final - initial}`,
      `(final − initial) / initial = ${final - initial} / ${initial} = ${fmt((final - initial) / initial)}`,
      `× 100 = ${roi.toFixed(4)}%`,
    ],
    result: round(roi, 4),
  };
}

function calcCompound(P, ratePct, t, n) {
  ensurePositive("principal", P);
  if (n <= 0) throw new Error("compounds_per_year must be > 0");
  if (t <= 0) throw new Error("years must be > 0");
  const r = ratePct / 100;
  const A = P * Math.pow(1 + r / n, n * t);
  return {
    formula: "A = P · (1 + r/n)^(n·t)",
    steps: [
      `r/n = ${r}/${n} = ${fmt(r / n)}`,
      `1 + r/n = ${fmt(1 + r / n)}`,
      `n·t = ${n}·${t} = ${n * t}`,
      `(1 + r/n)^(n·t) = ${fmt(Math.pow(1 + r / n, n * t))}`,
      `A = ${P} · ${fmt(Math.pow(1 + r / n, n * t))} = ${A.toFixed(4)}`,
    ],
    result: round(A, 4),
  };
}

function calcCagr(beg, end, years) {
  ensurePositive("beginning", beg);
  if (years <= 0) throw new Error("years must be > 0");
  if (end <= 0) {
    return {
      formula: "CAGR = (ending / beginning)^(1/years) − 1",
      steps: ["ending ≤ 0 — position wiped out; CAGR floored at −100%."],
      result: -100,
    };
  }
  const ratio = end / beg;
  const cagr = Math.pow(ratio, 1 / years) - 1;
  return {
    formula: "CAGR = (ending / beginning)^(1/years) − 1",
    steps: [
      `ending / beginning = ${end} / ${beg} = ${fmt(ratio)}`,
      `^(1/${years}) = ${fmt(Math.pow(ratio, 1 / years))}`,
      `− 1 = ${fmt(cagr)} → ${(cagr * 100).toFixed(4)}%`,
    ],
    result: round(cagr * 100, 4),
  };
}

function calcNpv(ratePct, cfs) {
  if (!cfs.length) throw new Error("cashflows must not be empty");
  const r = ratePct / 100;
  let npv = 0;
  const steps = [];
  for (let t = 0; t < cfs.length; t++) {
    const term = cfs[t] / Math.pow(1 + r, t);
    npv += term;
    steps.push(`t=${t}: ${cfs[t]} / (1+${r})^${t} = ${term.toFixed(4)}`);
  }
  steps.push(`sum = ${npv.toFixed(4)}`);
  return {
    formula: "NPV = Σ CF_t / (1 + r)^t",
    steps,
    result: round(npv, 4),
  };
}

// Newton-Raphson IRR. Matches numpy_financial.irr behaviour: takes the
// cashflow array (t=0 is the initial outlay, typically negative), finds r
// such that NPV(r) = 0. Falls back to a bisection bracket if Newton stalls.
function calcIrr(cfs) {
  if (cfs.length < 2) throw new Error("need at least 2 cashflows");
  const hasNeg = cfs.some(c => c < 0);
  const hasPos = cfs.some(c => c > 0);
  if (!hasNeg || !hasPos) throw new Error("cashflows must contain at least one negative and one positive value");

  const npv = (r) => cfs.reduce((s, cf, t) => s + cf / Math.pow(1 + r, t), 0);
  const dnpv = (r) => cfs.reduce((s, cf, t) => t === 0 ? s : s - t * cf / Math.pow(1 + r, t + 1), 0);

  let r = 0.1;
  for (let i = 0; i < 50; i++) {
    const f = npv(r);
    const df = dnpv(r);
    if (Math.abs(df) < 1e-12) break;
    const next = r - f / df;
    if (!isFinite(next)) break;
    if (Math.abs(next - r) < 1e-9) { r = next; break; }
    r = next;
    if (r <= -0.9999) r = -0.9999;
  }

  if (!isFinite(r) || Math.abs(npv(r)) > 1e-4) {
    // Bisection fallback over [-0.99, 10]
    let lo = -0.99, hi = 10;
    if (npv(lo) * npv(hi) > 0) throw new Error("IRR did not converge for these cashflows");
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      const fmid = npv(mid);
      if (Math.abs(fmid) < 1e-7) { r = mid; break; }
      if (npv(lo) * fmid < 0) hi = mid; else lo = mid;
      r = mid;
    }
  }

  return {
    formula: "Find r such that Σ CF_t / (1 + r)^t = 0",
    steps: [
      `Newton-Raphson on ${cfs.length} cashflows`,
      `r ≈ ${fmt(r)} → ${(r * 100).toFixed(4)}%`,
    ],
    result: round(r * 100, 4),
  };
}

function calcSharpe(returns, rf) {
  if (returns.length < 2) throw new Error("need at least 2 returns");
  const n = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  if (std === 0) {
    return {
      formula: "Sharpe = (mean(returns) − risk_free_rate) / std(returns)",
      steps: [`mean = ${fmt(mean)}`, "std = 0 (all returns equal) — Sharpe is undefined."],
      result: null,
    };
  }
  const sharpe = (mean - rf) / std;
  return {
    formula: "Sharpe = (mean(returns) − risk_free_rate) / std(returns)",
    steps: [
      `mean = ${fmt(mean)}`,
      `std = ${fmt(std)}`,
      `(mean − rf) / std = (${fmt(mean)} − ${rf}) / ${fmt(std)} = ${sharpe.toFixed(4)}`,
    ],
    result: round(sharpe, 4),
  };
}

function calcPayback(initial, annualCf) {
  ensurePositive("initial_investment", initial);
  if (annualCf <= 0) throw new Error("annual_cash_flow must be > 0");
  const years = initial / annualCf;
  return {
    formula: "Payback (years) = initial_investment / annual_cash_flow",
    steps: [`${initial} / ${annualCf} = ${years.toFixed(4)} years`],
    result: round(years, 4),
  };
}

function calcBreakeven(fc, price, vc) {
  ensurePositive("fixed_costs", fc);
  const margin = price - vc;
  if (margin <= 0) throw new Error("price must be greater than variable cost");
  const units = fc / margin;
  return {
    formula: "Break-even units = FC / (P − VC)",
    steps: [
      `contribution margin = P − VC = ${price} − ${vc} = ${margin}`,
      `FC / margin = ${fc} / ${margin} = ${units.toFixed(4)} units`,
    ],
    result: round(units, 4),
  };
}

function calcAnnualized(totalReturnPct, days) {
  if (days <= 0) throw new Error("days must be > 0");
  const total = totalReturnPct / 100;
  if (total <= -1) throw new Error("total return must be > -100%");
  const a = Math.pow(1 + total, 365 / days) - 1;
  return {
    formula: "Annualized = (1 + total_return)^(365/days) − 1",
    steps: [
      `1 + total = ${fmt(1 + total)}`,
      `365 / ${days} = ${fmt(365 / days)}`,
      `^ → ${fmt(Math.pow(1 + total, 365 / days))}`,
      `− 1 = ${fmt(a)} → ${(a * 100).toFixed(4)}%`,
    ],
    result: round(a * 100, 4),
  };
}

function round(n, d) {
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
}
