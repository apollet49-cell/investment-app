import { API, state, money, spinner, escapeHtml, onViewCleanup } from "/static/app.js";
import { t } from "/static/i18n.js";

const TMI_OPTIONS = [0, 11, 30, 41, 45];

let tmi = 30;
let peaYears = 5;
let avYears = 8;

export async function render(root) {
  root.innerHTML = `<div style="text-align:center;padding:40px">${spinner(true)}</div>`;
  await refresh(root);
  // Auto-refresh on input changes is wired inside refresh().
}

async function refresh(root) {
  let data;
  try {
    data = await API.request(`/tax/summary?tmi=${tmi}&pea_years=${peaYears}&av_years=${avYears}`);
  } catch (err) {
    root.innerHTML = `<div class="alert-banner error">${escapeHtml(err.message)}</div>`;
    return;
  }
  draw(root, data);
}

function draw(root, data) {
  const wrappers = data.wrappers || [];
  const optimalTax = data.total_tax_optimal || 0;
  const worstTax = data.total_tax_worst || 0;
  const savings = data.tax_savings_via_optimal || 0;
  const pea = data.pea_cap || {};

  const tmiButtons = TMI_OPTIONS.map(v =>
    `<button class="btn ${v === tmi ? "btn-primary" : "btn-ghost"}" data-tmi="${v}">${v}%</button>`
  ).join("");

  root.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">${t("tax.title")}</h3>
      <p style="color:var(--text-muted);font-size:13px;margin:0 0 14px">${t("tax.subtitle")}</p>

      <div class="row">
        <div class="col field">
          <label>${t("tax.tmi")}</label>
          <div style="display:flex;gap:4px;flex-wrap:wrap">${tmiButtons}</div>
        </div>
        <div class="col field">
          <label>${t("tax.pea_years")}</label>
          <input id="tax-pea-years" type="number" min="0" max="40" step="0.5" value="${peaYears}"/>
        </div>
        <div class="col field">
          <label>${t("tax.av_years")}</label>
          <input id="tax-av-years" type="number" min="0" max="40" step="0.5" value="${avYears}"/>
        </div>
      </div>
    </div>

    <div style="height:14px"></div>

    <div class="summary-grid">
      ${summary(t("tax.total_tax_optimal"), money(optimalTax), savings > 0 ? "positive" : "")}
      ${summary(t("tax.total_tax_worst"), money(worstTax))}
      ${summary(t("tax.savings"), money(savings), "positive")}
    </div>

    <div style="height:14px"></div>

    <div class="card">
      <h3 style="margin-top:0">${t("tax.by_wrapper")}</h3>
      ${wrappers.length === 0
        ? `<div class="empty-state"><p>${t("tax.empty")}</p></div>`
        : wrappers.map(renderWrapper).join("")}
    </div>

    <div style="height:14px"></div>

    <div class="card">
      <h3 style="margin-top:0">${t("tax.pea_cap_title")}</h3>
      <div style="margin-bottom:8px">${t("tax.pea_cap_used")}: <strong>${money(pea.used_usd || 0)}</strong> / ${money(pea.limit_eur || 150000)}</div>
      <div style="background:var(--border);border-radius:999px;height:10px;overflow:hidden">
        <div style="background:${(pea.used_pct || 0) > 90 ? "var(--danger)" : (pea.used_pct || 0) > 70 ? "var(--warning)" : "var(--success)"};height:100%;width:${Math.min(100, pea.used_pct || 0)}%"></div>
      </div>
      <div style="color:var(--text-muted);font-size:12px;margin-top:6px">
        ${(pea.used_pct || 0).toFixed(1)}% ${t("tax.pea_cap_used_pct")} · ${t("tax.pea_cap_remaining")}: ${money(pea.remaining_usd || 0)}
      </div>
    </div>

    <div class="hint" style="margin-top:14px;font-size:12px;color:var(--text-muted)">
      ${t("tax.disclaimer")}
    </div>
  `;

  // Wire input changes → reload
  for (const b of root.querySelectorAll("[data-tmi]")) {
    b.onclick = () => { tmi = parseInt(b.dataset.tmi, 10); refresh(root); };
  }
  const peaInput = document.getElementById("tax-pea-years");
  if (peaInput) {
    peaInput.onchange = () => {
      const v = parseFloat(peaInput.value);
      if (isFinite(v) && v >= 0) { peaYears = v; refresh(root); }
    };
  }
  const avInput = document.getElementById("tax-av-years");
  if (avInput) {
    avInput.onchange = () => {
      const v = parseFloat(avInput.value);
      if (isFinite(v) && v >= 0) { avYears = v; refresh(root); }
    };
  }
}

function summary(label, value, cls = "") {
  return `<div class="summary-card">
    <div class="label">${label}</div>
    <div class="value ${cls}" style="font-size:24px">${value}</div>
  </div>`;
}

function renderWrapper(w) {
  const scenarios = Object.entries(w.scenarios || {});
  return `
    <div style="border-top:1px solid var(--border);padding:16px 0">
      <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:12px;margin-bottom:8px">
        <div>
          <strong style="font-family:var(--font-serif);font-size:18px">${escapeHtml(w.label)}</strong>
          <span style="color:var(--text-muted);font-size:12px;margin-left:8px">${w.positions} position${w.positions > 1 ? "s" : ""}</span>
        </div>
        <div style="color:var(--text-muted);font-size:13px">
          ${t("tax.invested")}: <strong style="color:var(--text)">${money(w.invested)}</strong> ·
          ${t("tax.current")}: <strong style="color:var(--text)">${money(w.current)}</strong> ·
          ${t("tax.unrealised_gain")}: <strong style="color:${w.gain >= 0 ? "var(--success)" : "var(--danger)"}">${money(w.gain)}</strong>
        </div>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>${t("tax.scenario")}</th><th style="text-align:right">${t("tax.rate")}</th><th style="text-align:right">${t("tax.tax_amount")}</th></tr></thead>
        <tbody>
          ${scenarios.map(([k, s]) => `<tr ${s.tax === w.best_tax ? 'style="background:rgba(107,125,94,0.08)"' : ""}>
            <td>${escapeHtml(s.label)}</td>
            <td style="text-align:right">${s.rate_pct.toFixed(2)}%</td>
            <td style="text-align:right"><strong>${money(s.tax)}</strong></td>
          </tr>`).join("")}
        </tbody>
      </table></div>
    </div>`;
}
