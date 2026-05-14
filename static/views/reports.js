import { API, state, toast } from "/static/app.js";
import { t } from "/static/i18n.js";

export async function render(root) {
  root.innerHTML = `
    <div class="card">
      <h3>${t("reports.title")}</h3>
      <div style="display:flex;flex-direction:column;gap:12px;max-width:480px">
        <button class="btn btn-primary" id="dl-csv">${t("reports.csv_portfolio")}</button>
        <button class="btn btn-primary" id="dl-csv-scenarios">${t("reports.csv_scenarios")}</button>
        <button class="btn btn-primary" id="dl-xlsx">${t("reports.xlsx_workbook")}</button>
        <button class="btn btn-primary" id="dl-pdf">${t("reports.pdf_report")}</button>
        <p class="sub" style="color:var(--text-muted);font-size:12px">${t("reports.pdf_help")}</p>
        <p class="sub" style="color:var(--text-muted);font-size:12px">${t("reports.xlsx_help")}</p>
      </div>
    </div>`;
  document.getElementById("dl-csv").onclick = () => downloadAuth("/exports/csv");
  document.getElementById("dl-csv-scenarios").onclick = () => downloadAuth("/exports/scenarios.csv");
  document.getElementById("dl-xlsx").onclick = () => downloadAuth("/exports/xlsx");
  document.getElementById("dl-pdf").onclick = downloadPdf;
}

async function downloadAuth(path) {
  // Browsers won't add the Authorization header on a plain <a href> click, so
  // we fetch with auth ourselves and trigger the download from the blob.
  try {
    const res = await fetch(path, { headers: { Authorization: `Bearer ${state.token}` } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || res.statusText);
    }
    const blob = await res.blob();
    const dispo = res.headers.get("Content-Disposition") || "";
    const m = dispo.match(/filename="([^"]+)"/);
    const filename = m ? m[1] : path.split("/").pop();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (e) { toast(e.message, "error"); }
}

async function downloadPdf() {
  try {
    const res = await fetch("/exports/pdf", { headers: { Authorization: `Bearer ${state.token}` } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || res.statusText);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `investment-report-${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (e) { toast(e.message, "error"); }
}
