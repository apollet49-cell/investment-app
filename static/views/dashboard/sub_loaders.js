// Async loaders that hydrate individual cards on the dashboard. Each one
// expects an `isCancelled` callback so it bails out if the user has
// navigated away mid-fetch. The render() in dashboard.js draws empty
// placeholders, then these fire in parallel to fill them in.
import { cachedGet, escapeHtml, money, pct, spinner, state } from "/static/app.js";
import { t } from "/static/i18n.js";

export async function loadFireYears(isCancelled) {
  const yEl = document.getElementById("fire-years");
  const sEl = document.getElementById("fire-sub");
  if (!yEl || !sEl) return;
  // If FX rate fetch failed for a non-USD user, the conversion would silently
  // use 1.0 and give a misleading "years to FIRE". Surface that to the user
  // instead — they should refresh after FX comes back.
  if (state.fxFailed) {
    yEl.textContent = "—";
    sEl.textContent = t("dashboard.fx_failed");
    return;
  }
  try {
    const fx = state.fxRate || 1.0;
    const expensesUsd = Math.round(2500 / fx);
    const savingsUsd = Math.round(1500 / fx);
    const data = await cachedGet(`/planning/fire?monthly_expenses=${expensesUsd}&monthly_savings=${savingsUsd}&expected_return_pct=7&target_multiplier=25`);
    if (isCancelled()) return;
    if (data.already_fire) {
      yEl.textContent = "🎉";
      sEl.textContent = t("dashboard.fire_already");
    } else if (data.years_to_fire == null) {
      yEl.textContent = "—";
      sEl.textContent = t("dashboard.fire_unreachable");
    } else {
      yEl.textContent = data.years_to_fire.toFixed(1);
      sEl.textContent = `${t("dashboard.fire_at_25x")} (${(data.progress_pct || 0).toFixed(0)}% ${t("dashboard.fire_progress")})`;
    }
  } catch (_) {
    if (sEl) sEl.textContent = t("dashboard.fire_unreachable");
  }
}

export async function loadRealRisk(isCancelled) {
  try {
    const data = await cachedGet("/dashboard/risk?days=180&benchmark=^GSPC");
    if (isCancelled()) return;
    if (data.score == null) return; // not enough snapshots yet — keep fallback
    const tone = data.score <= 25 ? "var(--success)"
               : data.score <= 60 ? "var(--warning)"
               : "var(--danger)";
    const tierKey = data.score <= 25 ? "dashboard.risk_low"
                  : data.score <= 60 ? "dashboard.risk_medium"
                  : "dashboard.risk_high";
    const vEl = document.getElementById("risk-value");
    const mEl = document.getElementById("risk-marker");
    const tEl = document.getElementById("risk-tier");
    const sEl = document.getElementById("risk-sub");
    if (vEl) {
      vEl.innerHTML = `${data.score.toFixed(0)}<span style="font-size:12px;color:var(--text-muted);font-family:var(--font-sans)"> / 100</span>` +
        (tEl ? "" : `<span id="risk-tier" style="font-size:12px;color:${tone};font-family:var(--font-sans);margin-left:4px">${t(tierKey)}</span>`);
      vEl.style.color = tone;
      vEl.style.display = "flex";
      vEl.style.alignItems = "baseline";
      vEl.style.gap = "6px";
    }
    if (tEl) {
      tEl.textContent = t(tierKey);
      tEl.style.color = tone;
    }
    if (mEl) mEl.style.left = `${Math.max(0, Math.min(100, data.score))}%`;
    if (sEl) {
      const parts = [];
      if (data.volatility_pct != null) parts.push(`${t("dashboard.risk_vol")}: ${data.volatility_pct.toFixed(1)}%`);
      if (data.max_drawdown_pct != null) parts.push(`${t("dashboard.risk_dd")}: ${data.max_drawdown_pct.toFixed(1)}%`);
      if (data.beta != null) parts.push(`β: ${data.beta.toFixed(2)}`);
      sEl.textContent = parts.join(" · ") || `${data.n_days} ${t("dashboard.risk_days")}`;
    }
  } catch (e) {
    const sEl = document.getElementById("risk-sub");
    if (sEl) sEl.textContent = t("dashboard.risk_unavailable");
  }
}

export async function loadPerformance(isCancelled) {
  try {
    const data = await cachedGet("/dashboard/performance");
    if (isCancelled()) return;
    const xirrEl = document.getElementById("perf-xirr");
    const subEl = document.getElementById("perf-sub");
    if (!xirrEl || !subEl) return;
    if (data.xirr_pct != null) {
      xirrEl.textContent = pct(data.xirr_pct);
      xirrEl.classList.add(data.xirr_pct >= 0 ? "positive" : "negative");
    } else {
      xirrEl.textContent = "—";
    }
    // Sub-line: TWR + try to compute vs S&P 500 from the history endpoint.
    const parts = [];
    if (data.twr_pct != null) parts.push(`${t("dashboard.twr")}: ${pct(data.twr_pct)}`);
    try {
      const h = await cachedGet("/dashboard/history?days=365&benchmark=^GSPC");
      if (!isCancelled() && h?.portfolio?.length > 1 && h.benchmark?.length > 0) {
        const youEnd = h.portfolio[h.portfolio.length - 1].normalized;
        const benchEnd = h.benchmark[h.benchmark.length - 1].normalized;
        const diff = youEnd - benchEnd;
        const sign = diff >= 0 ? "+" : "";
        const cls = diff >= 0 ? "positive" : "negative";
        parts.push(`<span class="${cls}">${sign}${diff.toFixed(1)} ${t("dashboard.vs_sp500")}</span>`);
      }
    } catch (_) {}
    if (parts.length === 0) parts.push(t("dashboard.xirr_no_data"));
    subEl.innerHTML = parts.join(" · ");
  } catch (e) {
    const subEl = document.getElementById("perf-sub");
    if (subEl) subEl.textContent = t("dashboard.xirr_no_data");
  }
}

export async function loadStressTest() {
  const host = document.getElementById("stress-test-body");
  if (!host) return;
  try {
    const data = await cachedGet("/planning/stress-test");
    if (!data.scenarios || !data.scenarios.length) {
      host.innerHTML = `<div style="color:var(--text-muted);font-size:13px">${t("dashboard.no_positions_for_stress")}</div>`;
      return;
    }
    host.innerHTML = `
      <div style="margin-bottom:8px;font-size:13px;color:var(--text-muted)">
        ${t("dashboard.baseline")}: <strong style="color:var(--text)">${money(data.baseline)}</strong>
      </div>
      <div class="table-wrap"><table class="data" style="font-size:12.5px">
        <thead><tr>
          <th>${t("dashboard.scenario")}</th>
          <th style="text-align:right">${t("dashboard.under_value")}</th>
          <th style="text-align:right">${t("dashboard.loss")}</th>
          <th style="text-align:right">${t("dashboard.impact")}</th>
        </tr></thead>
        <tbody>
        ${data.scenarios.map(s => `
          <tr>
            <td><strong>${escapeHtml(s.label)}</strong><div style="color:var(--text-muted);font-size:11px">${escapeHtml(s.description)}</div></td>
            <td style="text-align:right">${money(s.value)}</td>
            <td style="text-align:right;color:${s.loss < 0 ? 'var(--danger)' : 'var(--text-muted)'}">${s.loss < 0 ? money(s.loss) : '—'}</td>
            <td style="text-align:right">
              <span class="badge ${s.loss_pct <= -25 ? 'red' : s.loss_pct <= -10 ? 'yellow' : 'gray'}" style="font-variant-numeric:tabular-nums">${s.loss_pct.toFixed(1)}%</span>
            </td>
          </tr>`).join("")}
        </tbody>
      </table></div>`;
  } catch (e) {
    host.innerHTML = `<div class="alert-banner error" style="margin:0">${escapeHtml(e.message)}</div>`;
  }
}

export async function loadDividendCalendar() {
  const host = document.getElementById("dividend-calendar-body");
  const summaryEl = document.getElementById("dividend-annual-summary");
  if (!host) return;
  try {
    const data = await cachedGet("/dividends/calendar");
    if (summaryEl && data.annual_income_estimate_usd) {
      summaryEl.innerHTML = `${t("dashboard.dividend_estimate")}: <strong style="color:var(--text)">${money(data.annual_income_estimate_usd)}/yr</strong>`;
    }
    if (!data.upcoming || !data.upcoming.length) {
      host.innerHTML = `<div style="color:var(--text-muted);font-size:13px">${t("dashboard.no_upcoming_dividends")}</div>`;
      return;
    }
    host.innerHTML = `
      <div class="table-wrap"><table class="data" style="font-size:12.5px">
        <thead><tr>
          <th>${t("dashboard.div_asset")}</th>
          <th>${t("dashboard.div_next_ex")}</th>
          <th style="text-align:right">${t("dashboard.div_yield")}</th>
          <th style="text-align:right">${t("dashboard.div_next_payment")}</th>
        </tr></thead>
        <tbody>
          ${data.upcoming.slice(0, 10).map(d => `<tr>
            <td><strong>${escapeHtml(d.name)}</strong> <span style="color:var(--text-muted);font-size:11px">${escapeHtml(d.symbol)}</span></td>
            <td>${d.next_ex_div || "—"}</td>
            <td style="text-align:right">${d.annual_yield_pct != null ? d.annual_yield_pct.toFixed(2) + "%" : "—"}</td>
            <td style="text-align:right">${d.estimated_next_payment_usd != null ? money(d.estimated_next_payment_usd) : "—"}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>`;
  } catch (e) {
    host.innerHTML = `<div class="alert-banner error" style="margin:0">${escapeHtml(e.message)}</div>`;
  }
}
