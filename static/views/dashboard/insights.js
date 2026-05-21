// Empty-state + "Hot Take" hero card + first-run demo loader. The hot
// take is computed client-side from data already in the summary payload
// — no extra round-trip, no LLM cost. Insights are ordered by importance:
// concentration → big winner → asset-class imbalance → crypto exposure
// → diversification → default.
import { API, confirmModal, escapeHtml, toast, track } from "/static/app.js";
import { t } from "/static/i18n.js";

export function heroInsight(data) {
  const div = data.diversification || {};
  const top = (div.top_positions || [])[0];
  const byType = data.by_type || {};
  const totalValue = data.current_value || 0;
  if (!totalValue) return "";

  let line = "", sub = "", tone = "neutral", icon = "✦";

  // 1. Single-position concentration risk (≥40%)
  if (top && top.weight_pct >= 40) {
    line = t("dashboard.insight_concentration").replace("{name}", top.name).replace("{pct}", top.weight_pct.toFixed(0));
    sub = t("dashboard.insight_concentration_sub");
    tone = "warning"; icon = "⚠";
  }
  // 2. Big winner — best performer ≥50% gain
  else if (data.best_performer && data.best_performer.roi_pct >= 50) {
    line = t("dashboard.insight_winner").replace("{name}", data.best_performer.name).replace("{pct}", data.best_performer.roi_pct.toFixed(0));
    sub = t("dashboard.insight_winner_sub");
    tone = "positive"; icon = "▲";
  }
  // 3. Heavy crypto exposure (>25%)
  else if (byType.crypto && (byType.crypto / totalValue) >= 0.25) {
    const pctCrypto = ((byType.crypto / totalValue) * 100).toFixed(0);
    line = t("dashboard.insight_crypto").replace("{pct}", pctCrypto);
    sub = t("dashboard.insight_crypto_sub");
    tone = "warning"; icon = "₿";
  }
  // 4. Asset class imbalance — one type >80%
  else if (Object.values(byType).some(v => v / totalValue > 0.8)) {
    const dominant = Object.entries(byType).find(([, v]) => v / totalValue > 0.8);
    const pctDom = ((dominant[1] / totalValue) * 100).toFixed(0);
    line = t("dashboard.insight_imbalance").replace("{type}", t(`investments.types.${dominant[0]}`)).replace("{pct}", pctDom);
    sub = t("dashboard.insight_imbalance_sub");
    tone = "warning"; icon = "⚖";
  }
  // 5. Poor diversification (<30)
  else if (div.score != null && div.score < 30) {
    line = t("dashboard.insight_diversification").replace("{score}", div.score.toFixed(0));
    sub = t("dashboard.insight_diversification_sub");
    tone = "warning"; icon = "◇";
  }
  // 6. Strong overall ROI (>20%)
  else if (data.total_roi_pct >= 20) {
    line = t("dashboard.insight_strong").replace("{pct}", data.total_roi_pct.toFixed(1));
    sub = t("dashboard.insight_strong_sub");
    tone = "positive"; icon = "▲";
  }
  // 7. Balanced & healthy (default for diversified positive portfolios)
  else if (div.score >= 70 && data.total_roi_pct >= 0) {
    line = t("dashboard.insight_balanced").replace("{score}", div.score.toFixed(0));
    sub = t("dashboard.insight_balanced_sub");
    tone = "positive"; icon = "✦";
  }
  // 8. Default — neutral
  else {
    line = t("dashboard.insight_default").replace("{count}", String((div.top_positions || []).length));
    sub = t("dashboard.insight_default_sub");
    tone = "neutral"; icon = "✦";
  }

  return `
    <div class="hero-insight hero-${tone}">
      <div class="hero-icon">${icon}</div>
      <div class="hero-body">
        <div class="hero-line">${escapeHtml(line)}</div>
        <div class="hero-sub">${escapeHtml(sub)}</div>
      </div>
      <a class="hero-cta" href="#/review">${t("dashboard.open_review")} →</a>
    </div>`;
}

export function emptyState() {
  return `
    <div class="card empty-state">
      <svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="3">
        <rect x="10" y="40" width="12" height="30" rx="2"/>
        <rect x="34" y="25" width="12" height="45" rx="2"/>
        <rect x="58" y="10" width="12" height="60" rx="2"/>
      </svg>
      <h3>${t("dashboard.no_investments_title")}</h3>
      <p>${t("dashboard.no_investments_sub")}</p>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:14px">
        <button id="dash-empty-add" class="btn btn-primary">${t("dashboard.add_investment")}</button>
        <button id="dash-empty-seed" class="btn btn-ghost">${t("dashboard.try_demo_data")}</button>
      </div>
      <p style="color:var(--text-muted);font-size:12px;margin-top:14px;max-width:420px;margin-left:auto;margin-right:auto">${t("dashboard.try_demo_hint")}</p>
    </div>`;
}

export async function loadDemoData() {
  const btn = document.getElementById("dash-empty-seed");
  if (!btn) return;
  const ok = await confirmModal({
    title: t("common.confirm") || "Confirm",
    message: t("dashboard.try_demo_confirm"),
    confirmText: t("common.continue") || "Continue",
    cancelText: t("common.cancel") || "Cancel",
    danger: true,
  });
  if (!ok) return;
  btn.disabled = true;
  btn.textContent = t("dashboard.try_demo_loading");
  try {
    await API.request("/investments/seed-demo", { method: "POST", body: { confirm_wipe: true } });
    track("demo_seeded");
    toast(t("dashboard.try_demo_done"), "success");
    // Re-render the dashboard from scratch so the new data shows up.
    setTimeout(() => location.reload(), 600);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = t("dashboard.try_demo_data");
    toast(e.message || "Seed failed", "error");
  }
}
