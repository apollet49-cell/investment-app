import { API, sendChatMessage, toast, spinner, escapeHtml } from "/static/app.js";
import { t } from "/static/i18n.js";

export async function render(root) {
  root.innerHTML = `
    <div class="card" style="display:flex;flex-direction:column;height:calc(100vh - 200px);min-height:500px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h3 style="margin:0">${t("chat.title")}</h3>
        <button class="btn btn-ghost" id="chat-page-clear">${t("chat.clear")}</button>
      </div>
      <div id="chat-page-messages" class="chat-messages" style="flex:1;border:1px solid var(--border);border-radius:6px"></div>
      <form id="chat-page-form" class="chat-form" style="border-top:none;padding:12px 0 0">
        <textarea id="chat-page-input" rows="2" placeholder="${t("chat.placeholder")}"></textarea>
        <button class="btn btn-primary" type="submit">${t("chat.send")}</button>
      </form>
    </div>`;

  const messages = document.getElementById("chat-page-messages");
  await loadHistory(messages);

  document.getElementById("chat-page-clear").onclick = async () => {
    try { await API.request("/chat/history", { method: "DELETE" }); await loadHistory(messages); }
    catch (e) { toast(e.message, "error"); }
  };

  document.getElementById("chat-page-form").onsubmit = (ev) => {
    ev.preventDefault();
    const ta = document.getElementById("chat-page-input");
    const text = ta.value.trim();
    if (!text) return;
    ta.value = "";
    sendChatMessage(text, messages);
  };
}

async function loadHistory(messagesEl) {
  messagesEl.innerHTML = `<div style="text-align:center;padding:20px">${spinner()}</div>`;
  try {
    const history = await API.request("/chat/history");
    if (!history.length) {
      messagesEl.innerHTML = `<div class="empty-state"><p>${t("chat.empty")}</p></div>`;
      return;
    }
    messagesEl.innerHTML = history.map(m => {
      const cls = m.role === "user" ? "user" : "assistant";
      return `<div class="msg ${cls}">${escapeHtml(m.content)}</div>`;
    }).join("");
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } catch (e) {
    messagesEl.innerHTML = `<div class="msg error">${escapeHtml(e.message)}</div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
