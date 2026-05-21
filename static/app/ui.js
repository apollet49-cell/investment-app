// Small UI primitives reused across views: toast banner, confirm modal,
// count-up number animation, spinner, and structural skeleton blocks
// that match the final layout so the page doesn't reflow on data arrival.
import { escapeHtml } from "/static/app.js";

export function toast(message, type = "info", ms = 3500) {
  const host = document.getElementById("toast-host");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// Styled confirm modal — replaces window.confirm() everywhere. Returns
// a Promise<boolean>. Renders a centered card with the message, two
// buttons (Cancel + Confirm). Escape / backdrop click resolve false.
// The Confirm button can be tinted "danger" for destructive actions.
export function confirmModal({ message, title = "", confirmText = "Confirm", cancelText = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    const safeTitle = title ? `<div class="confirm-title">${escapeHtml(title)}</div>` : "";
    overlay.innerHTML = `
      <div class="confirm-card" role="dialog" aria-modal="true">
        ${safeTitle}
        <div class="confirm-message">${escapeHtml(message)}</div>
        <div class="confirm-actions">
          <button class="btn btn-ghost confirm-cancel" type="button">${escapeHtml(cancelText)}</button>
          <button class="btn ${danger ? "btn-danger" : "btn-primary"} confirm-ok" type="button">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const okBtn = overlay.querySelector(".confirm-ok");
    const cancelBtn = overlay.querySelector(".confirm-cancel");
    okBtn.focus();
    const done = (val) => {
      overlay.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") done(false);
      if (e.key === "Enter") done(true);
    };
    overlay.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) done(false);
    });
    okBtn.onclick = () => done(true);
    cancelBtn.onclick = () => done(false);
  });
}

// Count-up animation on a DOM element. Used by the dashboard KPI cards
// so the net worth / total invested / ROI percentages animate from 0
// to their final value over ~700ms. Feels alive without being annoying.
// Pass `format(n)` for currency / percent / etc.; default is integer.
export function animateNumber(el, target, { duration = 700, format = (n) => Math.round(n).toString() } = {}) {
  if (!el || !isFinite(target)) return;
  const start = performance.now();
  const initial = 0;
  if (el._countAnim) cancelAnimationFrame(el._countAnim);
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    // ease-out-cubic — fast start, gentle landing
    const eased = 1 - Math.pow(1 - t, 3);
    const v = initial + (target - initial) * eased;
    el.textContent = format(v);
    if (t < 1) {
      el._countAnim = requestAnimationFrame(tick);
    } else {
      delete el._countAnim;
    }
  };
  el._countAnim = requestAnimationFrame(tick);
}

export function spinner(big = false) {
  return `<span class="spinner ${big ? "lg" : ""}"></span>`;
}

// Skeleton placeholders — match the final layout so the page doesn't
// reflow when data lands. `shape` is one of:
//   "kpi"   — 4 KPI cards in a grid (dashboard hero)
//   "chart" — a chart card
//   "table" — 8 table rows
//   "list"  — 4 list rows
// Use instead of spinner() for content that's visible in <1s. Beyond 1s
// users prefer feedback that something IS loading (spinner > skeleton).
export function skeleton(shape = "kpi") {
  const bar = (w = "100%", h = "12px") => `<div class="sk-bar" style="width:${w};height:${h}"></div>`;
  if (shape === "kpi") {
    return `<div class="summary-grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
      ${Array(4).fill(`
        <div class="summary-card sk">
          ${bar("60%", "11px")}
          ${bar("80%", "26px")}
          ${bar("50%", "11px")}
        </div>`).join("")}
    </div>
    <div class="card chart-card sk-chart"></div>`;
  }
  if (shape === "chart") {
    return `<div class="card chart-card sk-chart"></div>`;
  }
  if (shape === "table") {
    return `<div class="card">
      ${Array(8).fill(`<div class="sk-row">${bar("30%")}${bar("15%")}${bar("15%")}${bar("15%")}</div>`).join("")}
    </div>`;
  }
  if (shape === "list") {
    return `<div class="card">
      ${Array(4).fill(`<div class="sk-row">${bar("50%")}${bar("30%")}</div>`).join("")}
    </div>`;
  }
  return spinner(true);
}
