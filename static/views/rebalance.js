import { API, cachedGet, money, spinner, toast, escapeHtml, track, onViewCleanup } from "/static/app.js";
import { t } from "/static/i18n.js";

// Default canonical types — pre-populated rows in the editor.
// Must match INVESTMENT_TYPES in backend models.py — "cash" is intentionally
// absent until cash holdings become a real first-class asset type.
const DEFAULT_TYPES = ["stock", "etf", "crypto", "bond", "real_estate", "startup"];

let currentAlloc = {};   // {type: current_value}
let currentTotal = 0;

export async function render(root) {
  let cancelled = false;
  onViewCleanup(() => { cancelled = true; });
  const myRenderId = root.dataset.renderId;
  const stillOwnsRoot = () => !cancelled && root.dataset.renderId === myRenderId;

  root.innerHTML = `<div style="text-align:center;padding:40px">${spinner(true)}</div>`;
  try {
    // cachedGet("/investments/") matches the prewarmCache seed key from
    // login. The trailing slash matters — without it FastAPI 307-
    // redirects to the slashed URL (extra round-trip) AND we miss the
    // pre-warmed cache entry.
    const inv = await cachedGet("/investments/");
    if (!stillOwnsRoot()) return;
    currentAlloc = {};
    currentTotal = 0;
    for (const i of inv) {
      const v = i.current_value || 0;
      if (v <= 0) continue;
      currentAlloc[i.type] = (currentAlloc[i.type] || 0) + v;
      currentTotal += v;
    }
  } catch (err) {
    if (!stillOwnsRoot()) return;
    root.innerHTML = `<div class="alert-banner error">${escapeHtml(err.message)}</div>`;
    return;
  }
  if (!stillOwnsRoot()) return;
  draw(root);
}

function draw(root) {
  // Build the union of default types and existing portfolio types
  const types = Array.from(new Set([...DEFAULT_TYPES, ...Object.keys(currentAlloc)]));
  // Pre-fill targets equally across types that have a current allocation
  const present = types.filter(t => (currentAlloc[t] || 0) > 0);
  const evenPct = present.length > 0 ? Math.floor(100 / present.length) : 0;

  root.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">${t("rebalance.title")}</h3>
      <p style="color:var(--text-muted);font-size:13px;margin:0 0 14px">${t("rebalance.subtitle")}</p>
      <div class="summary-grid">
        ${kpi(t("rebalance.current_total"), money(currentTotal))}
        ${kpi(t("rebalance.types_count"), String(present.length))}
        ${kpi(t("rebalance.mode_label"), `<span id="mode-chip">${t("rebalance.mode_full")}</span>`)}
      </div>
    </div>

    <div style="height:14px"></div>

    <div class="card">
      <h3 style="margin-top:0">${t("rebalance.targets_title")}</h3>
      <p style="color:var(--text-muted);font-size:13px;margin:0 0 14px">${t("rebalance.targets_help")}</p>
      <div class="table-wrap">
        <table class="data">
          <thead><tr>
            <th>${t("rebalance.col_type")}</th>
            <th>${t("rebalance.col_current_value")}</th>
            <th>${t("rebalance.col_current_pct")}</th>
            <th style="width:160px">${t("rebalance.col_target_pct")}</th>
          </tr></thead>
          <tbody id="targets-body">
            ${types.map(tp => {
              const v = currentAlloc[tp] || 0;
              const curPct = currentTotal > 0 ? (v / currentTotal * 100) : 0;
              const tgt = v > 0 ? evenPct : 0;
              return `<tr>
                <td><span class="badge gray">${escapeHtml(tp)}</span></td>
                <td>${money(v)}</td>
                <td>${curPct.toFixed(1)}%</td>
                <td>
                  <input type="number" min="0" max="100" step="0.5"
                         data-type="${escapeHtml(tp)}"
                         value="${tgt}"
                         class="tgt-input"
                         style="width:100px;text-align:right" />
                  <span style="color:var(--text-muted);font-size:12px">%</span>
                </td>
              </tr>`;
            }).join("")}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3" style="text-align:right;font-weight:600">${t("rebalance.sum")}</td>
              <td><strong id="sum-pct">0.0%</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;align-items:flex-end">
        <div class="field" style="margin:0">
          <label>${t("rebalance.contribution_label")}</label>
          <input id="contribution" type="number" min="0" step="50" placeholder="0"
                 style="width:160px" />
          <div style="color:var(--text-muted);font-size:12px;margin-top:4px">${t("rebalance.contribution_help")}</div>
        </div>
        <div style="display:flex;gap:8px;margin-left:auto">
          <button class="btn btn-ghost" id="even-split">${t("rebalance.even_split")}</button>
          <button class="btn btn-primary" id="run-btn">${t("rebalance.run")}</button>
        </div>
      </div>
    </div>

    <div style="height:14px"></div>
    <div id="result-host"></div>
  `;

  const updateSum = () => {
    const sum = inputsSum(root);
    const el = document.getElementById("sum-pct");
    el.textContent = `${sum.toFixed(1)}%`;
    el.style.color = Math.abs(sum - 100) < 0.5 ? "var(--success)" : "var(--text-muted)";
  };
  const updateMode = () => {
    const c = parseFloat(document.getElementById("contribution").value || "0");
    document.getElementById("mode-chip").textContent =
      c > 0 ? t("rebalance.mode_contribution") : t("rebalance.mode_full");
  };
  for (const inp of root.querySelectorAll(".tgt-input")) {
    inp.addEventListener("input", updateSum);
  }
  document.getElementById("contribution").addEventListener("input", updateMode);
  updateSum();
  updateMode();

  document.getElementById("even-split").onclick = () => {
    const inputs = Array.from(root.querySelectorAll(".tgt-input"));
    const evenly = inputs.length > 0 ? Math.round((100 / inputs.length) * 10) / 10 : 0;
    for (const inp of inputs) inp.value = evenly;
    updateSum();
  };

  document.getElementById("run-btn").onclick = () => runRebalance(root);
}

function inputsSum(root) {
  let sum = 0;
  for (const inp of root.querySelectorAll(".tgt-input")) {
    const v = parseFloat(inp.value || "0");
    if (Number.isFinite(v) && v > 0) sum += v;
  }
  return sum;
}

async function runRebalance(root) {
  const target_by_type = {};
  for (const inp of root.querySelectorAll(".tgt-input")) {
    const v = parseFloat(inp.value || "0");
    if (Number.isFinite(v) && v > 0) target_by_type[inp.dataset.type] = v;
  }
  if (Object.keys(target_by_type).length === 0) {
    toast(t("rebalance.err_empty"), "error");
    return;
  }
  const sum = Object.values(target_by_type).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 2) {
    toast(t("rebalance.err_sum", { sum: sum.toFixed(1) }), "error");
    return;
  }
  const new_contribution = parseFloat(document.getElementById("contribution").value || "0") || 0;

  const host = document.getElementById("result-host");
  host.innerHTML = `<div class="card" style="text-align:center;padding:20px">${spinner()}</div>`;
  try {
    const data = await API.request("/planning/rebalance", {
      method: "POST",
      body: { target_by_type, new_contribution },
    });
    track("rebalance_run", { mode: data?.mode, has_contribution: new_contribution > 0 });
    renderResult(host, data);
  } catch (e) {
    host.innerHTML = `<div class="alert-banner error">${escapeHtml(e.message)}</div>`;
  }
}

function renderResult(host, data) {
  if (data.error) {
    host.innerHTML = `<div class="alert-banner error">${escapeHtml(data.error)}</div>`;
    return;
  }
  const modeLabel = data.mode === "contribution_only"
    ? t("rebalance.mode_contribution")
    : t("rebalance.mode_full");
  const buys = data.actions.filter(a => a.action === "buy");
  const sells = data.actions.filter(a => a.action === "sell");
  const totalBuy = buys.reduce((s, a) => s + a.amount_usd, 0);
  const totalSell = sells.reduce((s, a) => s + a.amount_usd, 0);

  host.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">${t("rebalance.result_title")}</h3>
      <div style="color:var(--text-muted);font-size:13px;margin-bottom:14px">
        ${t("rebalance.result_caption", { mode: modeLabel })}
      </div>
      <div class="summary-grid">
        ${kpi(t("rebalance.future_total"), money(data.future_total))}
        ${kpi(t("rebalance.total_to_buy"), money(totalBuy), "positive")}
        ${kpi(t("rebalance.total_to_sell"), money(totalSell), totalSell > 0 ? "negative" : "")}
        ${kpi(t("rebalance.actions_count"), String(data.actions.length))}
      </div>
    </div>

    <div style="height:14px"></div>

    <div class="card">
      <h3 style="margin-top:0">${t("rebalance.drift_title")}</h3>
      <div class="table-wrap">
        <table class="data">
          <thead><tr>
            <th>${t("rebalance.col_type")}</th>
            <th>${t("rebalance.col_current_value")}</th>
            <th>${t("rebalance.col_current_pct")}</th>
            <th>${t("rebalance.col_target_pct")}</th>
            <th>${t("rebalance.col_drift")}</th>
          </tr></thead>
          <tbody>
            ${data.comparison.map(c => {
              const drift = c.drift_pct;
              const cls = Math.abs(drift) < 1 ? "" : (drift > 0 ? "negative" : "positive");
              const arrow = drift > 0 ? "▲" : (drift < 0 ? "▼" : "·");
              return `<tr>
                <td><span class="badge gray">${escapeHtml(c.type)}</span></td>
                <td>${money(c.current_value)}</td>
                <td>${c.current_pct.toFixed(1)}%</td>
                <td>${c.target_pct.toFixed(1)}%</td>
                <td class="${cls}">${arrow} ${Math.abs(drift).toFixed(1)}%</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>

    <div style="height:14px"></div>

    <div class="card">
      <h3 style="margin-top:0">${t("rebalance.actions_title")}</h3>
      ${data.actions.length === 0
        ? `<p style="color:var(--text-muted)">${t("rebalance.no_actions")}</p>`
        : `<div class="table-wrap">
            <table class="data">
              <thead><tr>
                <th>${t("rebalance.col_type")}</th>
                <th>${t("rebalance.col_action")}</th>
                <th>${t("rebalance.col_amount")}</th>
              </tr></thead>
              <tbody>
                ${data.actions.map(a => `<tr>
                  <td><span class="badge gray">${escapeHtml(a.type)}</span></td>
                  <td>${a.action === "buy"
                    ? `<span class="badge green">${t("rebalance.buy")}</span>`
                    : `<span class="badge red">${t("rebalance.sell")}</span>`}</td>
                  <td><strong>${money(a.amount_usd)}</strong></td>
                </tr>`).join("")}
              </tbody>
            </table>
          </div>`}
      <p style="color:var(--text-muted);font-size:12px;margin-top:12px">${t("rebalance.disclaimer")}</p>
    </div>
  `;
}

function kpi(label, value, cls = "") {
  return `<div class="summary-card"><div class="label">${label}</div><div class="value ${cls}" style="font-size:22px">${value}</div></div>`;
}
