// HTML card builders for the dashboard's various scorecards: risk,
// diversification (inline + expandable), carbon footprint, and small
// helper cards. All return HTML strings — the parent view innerHTMLs
// them into place. State is encoded in DOM data-attributes; wiring
// (click handlers for the expand chevrons) lives in dashboard.js.
import { escapeHtml } from "/static/app.js";
import { t } from "/static/i18n.js";

export function summaryCard(label, value, cls = "") {
  return `<div class="summary-card"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
}

export function bestPerformerCard(label, name, roiText, roiClass) {
  return `<div class="summary-card">
    <div class="label">${label}</div>
    <div class="value compact">${escapeHtml(name)}</div>
    <div class="sub ${roiClass}" style="font-weight:500;font-size:13px;margin-top:4px">${roiText}</div>
  </div>`;
}

export function riskCard(div) {
  const label = t("dashboard.risk_score");
  // Initial placeholder — `loadRealRisk()` swaps in the real metrics
  // (volatility, max drawdown, beta) once /dashboard/risk responds. Until
  // then we show the concentration-based "risk_score" so the card isn't
  // empty for the ~200ms it takes to compute.
  const fallback = div?.risk_score;
  if (fallback == null) {
    return `<div class="summary-card" id="risk-card-host">
      <div class="label">${label}</div>
      <div class="value" id="risk-value" style="font-size:22px">—</div>
      <div class="sub" id="risk-sub" style="font-size:11px;margin-top:6px;color:var(--text-muted)">${t("dashboard.risk_loading")}</div>
    </div>`;
  }
  const clamped = Math.max(0, Math.min(100, fallback));
  const tone = fallback <= 25 ? "var(--success)" : fallback <= 60 ? "var(--warning)" : "var(--danger)";
  const tier = fallback <= 25 ? t("dashboard.risk_low")
             : fallback <= 60 ? t("dashboard.risk_medium")
             : t("dashboard.risk_high");
  return `<div class="summary-card" id="risk-card-host">
    <div class="label">${label}</div>
    <div class="value" id="risk-value" style="color:${tone};display:flex;align-items:baseline;gap:6px">
      ${fallback.toFixed(0)}<span style="font-size:12px;color:var(--text-muted);font-family:var(--font-sans)"> / 100</span>
      <span id="risk-tier" style="font-size:12px;color:${tone};font-family:var(--font-sans);margin-left:4px">${tier}</span>
    </div>
    <div class="risk-gauge"><div class="marker" id="risk-marker" style="left:${clamped}%"></div></div>
    <div class="risk-gauge-scale"><span>${t("dashboard.risk_low")}</span><span>${t("dashboard.risk_medium")}</span><span>${t("dashboard.risk_high")}</span></div>
    <div class="sub" id="risk-sub" style="font-size:11px;margin-top:6px;color:var(--text-muted)">${t("dashboard.risk_loading")}</div>
  </div>`;
}

export function diversificationInline(div) {
  if (!div || div.score == null) return `<p style="color:var(--text-muted)">—</p>`;
  const score = div.score;
  const color = score >= 75 ? "var(--success)" : score >= 50 ? "var(--warning)" : "var(--danger)";
  const topRows = (div.top_positions || []).slice(0, 5).map(p => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">
      <span style="color:var(--text-muted)">${escapeHtml(p.name)}</span>
      <strong>${p.weight_pct.toFixed(1)}%</strong>
    </div>`).join("");
  return `
    <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px">
      <div style="font-size:28px;color:${color};font-family:var(--font-serif)">${score.toFixed(0)}</div>
      <div style="color:var(--text-muted);font-size:12px">/ 100</div>
    </div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">${escapeHtml(div.message || "")}</div>
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin-bottom:6px">${t("dashboard.top_positions") || "Top positions"}</div>
    ${topRows || `<div style="color:var(--text-muted);font-size:12px">—</div>`}
  `;
}

export function diversificationCard(div) {
  const label = t("dashboard.diversification");
  if (!div || div.score == null) {
    return summaryCard(label, "—");
  }
  const score = div.score;
  const color = score >= 75 ? "var(--success)" : score >= 50 ? "var(--warning)" : "var(--danger)";
  const id = `div-card-${Math.random().toString(36).slice(2, 8)}`;
  const topRows = (div.top_positions || []).slice(0, 5).map(p => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">
      <span style="color:var(--text-muted)">${escapeHtml(p.name)}</span>
      <strong>${p.weight_pct.toFixed(1)}%</strong>
    </div>`).join("");
  const typeRows = Object.entries(div.type_distribution || {}).map(([k, v]) => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">
      <span style="color:var(--text-muted)">${escapeHtml(t(`investments.types.${k}`) || k)}</span>
      <strong>${v.toFixed(1)}%</strong>
    </div>`).join("");
  const sectorRows = Object.entries(div.sector_distribution || {}).map(([k, v]) => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">
      <span style="color:var(--text-muted)">${escapeHtml(k)}</span>
      <strong>${v.toFixed(1)}%</strong>
    </div>`).join("");
  const countryRows = Object.entries(div.country_distribution || {}).map(([k, v]) => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">
      <span style="color:var(--text-muted)">${escapeHtml(k)}</span>
      <strong>${v.toFixed(1)}%</strong>
    </div>`).join("");
  const riskFactors = (div.risk_factors || []).map(rf => `
    <div style="font-size:12px;padding:3px 0;color:var(--danger)">• ${escapeHtml(rf)}</div>`).join("");
  return `
  <div class="summary-card div-card" id="${id}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div class="label">${label}</div>
      <button class="div-toggle" data-target="${id}" style="background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:11px">⌄</button>
    </div>
    <div class="value" style="color:${color}">${score.toFixed(0)}<span style="font-size:14px;color:var(--text-muted);font-family:var(--font-sans)"> / 100</span></div>
    <div class="sub" style="font-size:11px;margin-top:6px">${escapeHtml(div.message || "")}</div>
    <div class="div-breakdown" style="display:none;margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
      ${riskFactors ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin-bottom:6px">${t("dashboard.risk_factors")}</div>${riskFactors}<div style="height:8px"></div>` : ""}
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin-bottom:6px">Top positions</div>
      ${topRows || '<div style="color:var(--text-muted);font-size:12px">—</div>'}
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin:10px 0 6px">By asset type</div>
      ${typeRows || '<div style="color:var(--text-muted);font-size:12px">—</div>'}
      ${sectorRows ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin:10px 0 6px">By sector (stocks)</div>${sectorRows}` : ""}
      ${countryRows ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin:10px 0 6px">By country</div>${countryRows}` : ""}
    </div>
  </div>`;
}

export function carbonCard(carbon) {
  const label = t("dashboard.carbon");
  if (!carbon || carbon.total_tco2e_year == null) {
    return summaryCard(label, "—");
  }
  const total = carbon.total_tco2e_year;
  const eq = carbon.equivalents || {};
  const color = total < 1 ? "var(--success)" : total < 5 ? "var(--warning)" : "var(--danger)";
  const id = `carbon-card-${Math.random().toString(36).slice(2, 8)}`;
  const breakdownRows = (carbon.breakdown || []).slice(0, 8).map(b => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">
      <span style="color:var(--text-muted)">${escapeHtml(b.name)} <span style="opacity:0.6">${escapeHtml(b.basis)}</span></span>
      <strong>${b.emissions_tco2e_year.toFixed(2)} t</strong>
    </div>`).join("");
  return `
  <div class="summary-card div-card" id="${id}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div class="label">${label}</div>
      <button class="div-toggle" data-target="${id}" style="background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:11px">⌄</button>
    </div>
    <div class="value" style="color:${color}">${total.toFixed(1)}<span style="font-size:14px;color:var(--text-muted);font-family:var(--font-sans)"> tCO₂e/yr</span></div>
    <div class="sub" style="font-size:11px;margin-top:6px">${escapeHtml(carbon.message || "")}</div>
    <div class="div-breakdown" style="display:none;margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin-bottom:8px">${t("dashboard.carbon_equivalents")}</div>
      <div style="font-size:12px;padding:3px 0">🚗 ≈ ${(eq.car_km || 0).toLocaleString()} ${t("dashboard.carbon_car_km")}</div>
      <div style="font-size:12px;padding:3px 0">✈️ ≈ ${eq.transatlantic_flights || 0} ${t("dashboard.carbon_flights")}</div>
      <div style="font-size:12px;padding:3px 0">🇫🇷 ${eq.french_avg_pct || 0}% ${t("dashboard.carbon_french_avg")}</div>
      ${breakdownRows ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin:12px 0 6px">${t("dashboard.carbon_top_emitters")}</div>${breakdownRows}` : ""}
    </div>
  </div>`;
}

// Permanent ranking shown directly below the carbon footprint card on
// the Risk & Carbon tab. The same `breakdown` data was previously only
// visible after clicking the chevron — now it's surfaced as a proper
// table so users immediately see which holdings drive their footprint.
export function carbonTopEmittersTable(carbon) {
  const breakdown = (carbon && carbon.breakdown) || [];
  if (!breakdown.length) return "";
  const total = carbon.total_tco2e_year || breakdown.reduce((s, b) => s + b.emissions_tco2e_year, 0) || 1;
  const rows = breakdown.slice(0, 10).map((b, i) => {
    const pct = (b.emissions_tco2e_year / total) * 100;
    const sym = b.symbol ? `<span style="color:var(--text-muted);font-size:11px;margin-left:6px">${escapeHtml(b.symbol)}</span>` : "";
    return `
      <div class="emitter-row">
        <div class="emitter-rank">${i + 1}</div>
        <div class="emitter-name"><strong>${escapeHtml(b.name)}</strong>${sym}<div class="emitter-basis">${escapeHtml(b.basis)}</div></div>
        <div class="emitter-bar-wrap"><div class="emitter-bar" style="width:${Math.min(100, pct).toFixed(1)}%"></div></div>
        <div class="emitter-val">${b.emissions_tco2e_year.toFixed(2)} <span style="color:var(--text-muted);font-size:11px">tCO₂e</span></div>
      </div>`;
  }).join("");
  return `
    <div class="card" style="margin-top:14px;padding:18px 20px 20px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px">
        <h4 style="margin:0;font-size:14px">${t("dashboard.carbon_top_emitters")}</h4>
        <span style="color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;font-family:var(--font-mono)">${t("dashboard.carbon_top_emitters_count").replace("{n}", String(breakdown.length))}</span>
      </div>
      <div class="emitter-list">${rows}</div>
    </div>`;
}
