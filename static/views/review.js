import { API, cachedGet, state, money, pct, skeleton, escapeHtml, onViewCleanup } from "/static/app.js";
import { t } from "/static/i18n.js";

// Monthly Portfolio Review — the killer feature.
//
// Stitches /dashboard/summary + /dashboard/performance + /dashboard/risk
// into a single print-ready page. The user can hit ⌘P / Ctrl+P and the
// browser produces a clean 1-page PDF (print styles strip the chrome).
//
// Every section is generated DETERMINISTICALLY from the user's portfolio
// data — no LLM call, no API key required, works for everyone including
// demo users. Each insight maps to a clearly identifiable rule (top
// holding > 40% → concentration warning, etc.) so the report is
// reproducible and explainable.

export async function render(root) {
  root.innerHTML = `<div class="review-shell">${skeleton("kpi")}</div>`;
  let summary, perf, risk;
  try {
    [summary, perf, risk] = await Promise.all([
      cachedGet("/dashboard/summary"),
      cachedGet("/dashboard/performance"),
      cachedGet("/dashboard/risk?days=180&benchmark=^GSPC"),
    ]);
  } catch (err) {
    root.innerHTML = `<div class="alert-banner error">${escapeHtml(err.message)}</div>`;
    return;
  }
  if (!summary.current_value) {
    root.innerHTML = `<div class="card empty-state">
      <h3>${t("review.empty_title")}</h3>
      <p>${t("review.empty_sub")}</p>
    </div>`;
    return;
  }

  const today = new Date();
  const monthName = today.toLocaleString(state.lang || "en", { month: "long", year: "numeric" });
  const userName = state.user?.name || "Investor";

  root.innerHTML = `
    <div class="review-shell">
      <header class="review-header">
        <div class="review-eyebrow">${t("review.eyebrow")}</div>
        <h1 class="review-title">${t("review.title_for").replace("{name}", escapeHtml(userName))}</h1>
        <div class="review-meta">${escapeHtml(monthName)} · ${t("review.generated_on")} ${today.toLocaleDateString(state.lang || "en")}</div>
        <button class="btn btn-ghost review-print no-print" id="review-print-btn">${t("review.print")} ⌘P</button>
      </header>

      <section class="review-section" id="ai-review-section" style="display:none">
        <h2>${t("review.section_ai_take")} <span class="ai-pill">AI</span></h2>
        <div id="ai-review-prose" class="review-ai-prose"></div>
      </section>

      <section class="review-section">
        <h2>${t("review.section_overview")}</h2>
        ${overviewBlock(summary, perf)}
      </section>

      <section class="review-section">
        <h2>${t("review.section_winners")}</h2>
        ${winnersBlock(summary)}
      </section>

      <section class="review-section">
        <h2>${t("review.section_allocation")}</h2>
        ${allocationBlock(summary)}
      </section>

      <section class="review-section">
        <h2>${t("review.section_risk")}</h2>
        ${riskBlock(risk, summary)}
      </section>

      <section class="review-section">
        <h2>${t("review.section_actions")}</h2>
        ${actionsBlock(summary, risk)}
      </section>

      <footer class="review-footer">
        ${t("review.footer")} · investapp · ${today.getFullYear()}
      </footer>
    </div>`;

  document.getElementById("review-print-btn")?.addEventListener("click", () => window.print());

  // Fetch the AI commentary in the background. If the user hasn't set an
  // Anthropic key the endpoint returns {available: false} and we leave
  // the section hidden — the deterministic review below is still useful.
  cachedGet("/dashboard/ai-review").then((res) => {
    if (!res?.available || !res.prose) return;
    const sec = document.getElementById("ai-review-section");
    const prose = document.getElementById("ai-review-prose");
    if (!sec || !prose) return;
    prose.innerHTML = res.prose
      .split(/\n\n+/)
      .map(p => `<p>${escapeHtml(p.trim())}</p>`)
      .join("");
    sec.style.display = "";
  }).catch(() => {});

  // Keyboard shortcut hint — make ⌘P actually print this view, not
  // a screenshot of the rest of the chrome.
  const onKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
      // Let the browser handle it — print styles take over.
    }
  };
  document.addEventListener("keydown", onKey);
  onViewCleanup(() => document.removeEventListener("keydown", onKey));
}

function overviewBlock(s, perf) {
  const delta = s.current_value - s.total_invested;
  const deltaSign = delta >= 0 ? "+" : "";
  const deltaCls = delta >= 0 ? "positive" : "negative";
  const xirr = perf?.xirr_pct;
  return `
    <div class="review-overview-grid">
      <div>
        <div class="review-stat-label">${t("review.net_worth")}</div>
        <div class="review-stat-value">${money(s.current_value)}</div>
        <div class="review-stat-sub ${deltaCls}">${deltaSign}${money(delta)} · ${pct(s.total_roi_pct)}</div>
      </div>
      <div>
        <div class="review-stat-label">${t("review.invested")}</div>
        <div class="review-stat-value">${money(s.total_invested)}</div>
        <div class="review-stat-sub">${t("review.across").replace("{n}", String((s.diversification?.top_positions || []).length))}</div>
      </div>
      <div>
        <div class="review-stat-label">${t("review.xirr")}</div>
        <div class="review-stat-value">${xirr != null ? pct(xirr) : "—"}</div>
        <div class="review-stat-sub">${t("review.xirr_sub")}</div>
      </div>
    </div>
    <p class="review-para">${overviewNarrative(s, perf)}</p>`;
}

function overviewNarrative(s, perf) {
  const delta = s.current_value - s.total_invested;
  if (delta >= 0 && s.total_roi_pct >= 20) {
    return t("review.narr_strong").replace("{pct}", s.total_roi_pct.toFixed(1));
  }
  if (delta >= 0) {
    return t("review.narr_positive").replace("{pct}", s.total_roi_pct.toFixed(1));
  }
  return t("review.narr_negative").replace("{pct}", Math.abs(s.total_roi_pct).toFixed(1));
}

function winnersBlock(s) {
  const positions = s.diversification?.top_positions || [];
  if (!positions.length) return `<p class="review-para">${t("review.no_data")}</p>`;
  const bestThree = positions.slice(0, 3);
  return `
    <ol class="review-list">
      ${bestThree.map((p, i) => `
        <li>
          <span class="review-rank">${i + 1}</span>
          <span class="review-name">${escapeHtml(p.name)}</span>
          <span class="review-weight">${p.weight_pct.toFixed(1)}% ${t("review.of_portfolio")}</span>
        </li>`).join("")}
    </ol>
    <p class="review-para">${winnersNarrative(s.best_performer)}</p>`;
}

function winnersNarrative(bp) {
  if (!bp) return t("review.no_winner");
  if (bp.roi_pct >= 50) return t("review.winner_strong").replace("{name}", escapeHtml(bp.name)).replace("{pct}", bp.roi_pct.toFixed(0));
  if (bp.roi_pct >= 10) return t("review.winner_steady").replace("{name}", escapeHtml(bp.name)).replace("{pct}", bp.roi_pct.toFixed(0));
  return t("review.winner_modest").replace("{name}", escapeHtml(bp.name));
}

function allocationBlock(s) {
  const byType = s.by_type || {};
  const total = Object.values(byType).reduce((a, b) => a + b, 0) || 1;
  const sorted = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  return `
    <div class="review-bars">
      ${sorted.map(([typ, val]) => {
        const pctShare = (val / total) * 100;
        return `
          <div class="review-bar-row">
            <div class="review-bar-label">${t(`investments.types.${typ}`)}</div>
            <div class="review-bar-track"><div class="review-bar-fill" style="width:${pctShare}%"></div></div>
            <div class="review-bar-pct">${pctShare.toFixed(1)}%</div>
          </div>`;
      }).join("")}
    </div>
    <p class="review-para">${allocationNarrative(s, byType, total)}</p>`;
}

function allocationNarrative(s, byType, total) {
  const div = s.diversification?.score;
  const dominant = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];
  if (dominant && dominant[1] / total > 0.8) {
    return t("review.alloc_imbalance").replace("{type}", t(`investments.types.${dominant[0]}`)).replace("{pct}", ((dominant[1] / total) * 100).toFixed(0));
  }
  if (div != null && div >= 70) return t("review.alloc_diversified").replace("{score}", div.toFixed(0));
  if (div != null && div < 40) return t("review.alloc_concentrated").replace("{score}", div.toFixed(0));
  return t("review.alloc_neutral");
}

function riskBlock(risk, s) {
  if (!risk || risk.score == null) {
    return `<p class="review-para">${t("review.risk_insufficient")}</p>`;
  }
  const tier = risk.score <= 25 ? t("dashboard.risk_low") : risk.score <= 60 ? t("dashboard.risk_medium") : t("dashboard.risk_high");
  return `
    <div class="review-risk-summary">
      <div>
        <div class="review-stat-label">${t("review.risk_score")}</div>
        <div class="review-stat-value">${risk.score.toFixed(0)} / 100</div>
        <div class="review-stat-sub">${tier}</div>
      </div>
      <div>
        <div class="review-stat-label">${t("review.volatility")}</div>
        <div class="review-stat-value">${risk.volatility_annualized_pct?.toFixed(1) || "—"}%</div>
        <div class="review-stat-sub">${t("review.annualized")}</div>
      </div>
      <div>
        <div class="review-stat-label">${t("review.max_drawdown")}</div>
        <div class="review-stat-value">${risk.max_drawdown_pct?.toFixed(1) || "—"}%</div>
        <div class="review-stat-sub">${risk.window_days || 180} ${t("dashboard.risk_days")}</div>
      </div>
    </div>
    <p class="review-para">${riskNarrative(risk)}</p>`;
}

function riskNarrative(r) {
  if (r.score >= 60) return t("review.risk_high_narr").replace("{score}", r.score.toFixed(0));
  if (r.score <= 25) return t("review.risk_low_narr").replace("{score}", r.score.toFixed(0));
  return t("review.risk_medium_narr").replace("{score}", r.score.toFixed(0));
}

// Generates 3 concrete, actionable recommendations from the portfolio
// rules. Each is a specific suggestion, not generic advice.
function actionsBlock(s, risk) {
  const actions = [];
  const div = s.diversification || {};
  const top = (div.top_positions || [])[0];
  const byType = s.by_type || {};
  const total = s.current_value || 1;

  if (top && top.weight_pct >= 40) {
    actions.push({
      title: t("review.action_trim_concentration").replace("{name}", escapeHtml(top.name)),
      detail: t("review.action_trim_detail").replace("{pct}", top.weight_pct.toFixed(0)),
    });
  }
  if (byType.crypto && byType.crypto / total >= 0.25) {
    actions.push({
      title: t("review.action_reduce_crypto"),
      detail: t("review.action_reduce_crypto_detail").replace("{pct}", ((byType.crypto / total) * 100).toFixed(0)),
    });
  }
  if (div.score != null && div.score < 30) {
    actions.push({
      title: t("review.action_diversify"),
      detail: t("review.action_diversify_detail").replace("{score}", div.score.toFixed(0)),
    });
  }
  if (risk?.score >= 70) {
    actions.push({ title: t("review.action_de_risk"), detail: t("review.action_de_risk_detail") });
  }
  if (!byType.bond) {
    actions.push({ title: t("review.action_add_bonds"), detail: t("review.action_add_bonds_detail") });
  }
  if (s.total_roi_pct >= 30) {
    actions.push({ title: t("review.action_rebalance_winners"), detail: t("review.action_rebalance_winners_detail") });
  }

  // Always at least 3 actions — fall back to general ones if rules didn't fire.
  while (actions.length < 3) {
    actions.push({ title: t("review.action_review_quarterly"), detail: t("review.action_review_quarterly_detail") });
  }

  return `
    <ol class="review-actions">
      ${actions.slice(0, 3).map((a, i) => `
        <li>
          <span class="review-action-num">${i + 1}</span>
          <div>
            <div class="review-action-title">${a.title}</div>
            <div class="review-action-detail">${a.detail}</div>
          </div>
        </li>`).join("")}
    </ol>`;
}
