// Floating chat panel — InvestAI assistant with tool-access to the user's
// real portfolio data. Mounted once at boot from app.js into <body> as a
// fixed-position bubble + slide-in panel. State is held in-module:
// history persists across opens during a session, resets on full reload.
import { API, escapeHtml, state } from "/static/app.js";

let mounted = false;
let history = [];      // [{role:'user'|'assistant', content:'...'}]
let waiting = false;

export function mountChatPanel() {
  if (mounted) return;
  mounted = true;

  const fab = document.createElement("button");
  fab.id = "chat-fab";
  fab.type = "button";
  fab.setAttribute("aria-label", "Ask InvestAI about your portfolio");
  fab.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.2L3 21l1.8-6.4A8 8 0 1 1 21 12z"/><circle cx="9" cy="12" r="0.8" fill="currentColor"/><circle cx="12" cy="12" r="0.8" fill="currentColor"/><circle cx="15" cy="12" r="0.8" fill="currentColor"/></svg>`;
  fab.style.cssText = `
    position:fixed; right:22px; bottom:24px; z-index:9000;
    width:54px; height:54px; border-radius:50%;
    background:var(--primary,#6b7d5e); color:var(--bg,#08080a);
    border:1px solid rgba(255,255,255,0.08);
    box-shadow:0 12px 32px -8px rgba(0,0,0,0.6); cursor:pointer;
    display:flex; align-items:center; justify-content:center;
    transition:transform .15s ease, background .15s ease;
  `;
  fab.onmouseenter = () => { fab.style.transform = "translateY(-2px)"; };
  fab.onmouseleave = () => { fab.style.transform = "translateY(0)"; };

  const panel = document.createElement("div");
  panel.id = "chat-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "InvestAI chat");
  panel.style.cssText = `
    position:fixed; right:22px; bottom:88px; z-index:9001;
    width:min(420px, calc(100vw - 32px));
    height:min(600px, calc(100vh - 120px));
    background:var(--surface,#0e0e11);
    border:1px solid rgba(255,255,255,0.08); border-radius:14px;
    box-shadow:0 30px 80px -40px rgba(0,0,0,0.7);
    display:none; flex-direction:column; overflow:hidden;
    font-family:var(--font-sans,Geist,system-ui,sans-serif);
  `;
  panel.innerHTML = `
    <div id="chat-head" style="padding:14px 16px; border-bottom:1px solid var(--border, rgba(255,255,255,0.08)); display:flex; align-items:center; gap:10px;">
      <span style="width:8px; height:8px; border-radius:50%; background:var(--primary,#6b7d5e); box-shadow:0 0 8px rgba(107,125,94,0.6);"></span>
      <strong style="font-family:var(--font-serif,'Instrument Serif',Georgia,serif); font-weight:400; font-size:17px;">InvestAI</strong>
      <span style="font-family:var(--font-mono,'Geist Mono',monospace); font-size:10px; letter-spacing:0.14em; color:var(--text-muted,#8c8c87); text-transform:uppercase; margin-left:6px;">agentic · reads your data</span>
      <button id="chat-close" type="button" aria-label="Close" style="margin-left:auto; background:transparent; border:none; color:var(--text-muted,#8c8c87); font-size:18px; cursor:pointer; padding:4px 8px;">×</button>
    </div>
    <div id="chat-msgs" style="flex:1; overflow-y:auto; padding:18px 16px; display:flex; flex-direction:column; gap:14px;"></div>
    <form id="chat-form" style="border-top:1px solid var(--border, rgba(255,255,255,0.08)); padding:12px; display:flex; gap:8px;">
      <textarea id="chat-input" rows="1" placeholder="Demande-moi : « quel est mon plus gros risque ? »" style="flex:1; resize:none; padding:10px 12px; border:1px solid var(--border, rgba(255,255,255,0.14)); border-radius:8px; background:var(--surface-2,#15151a); color:var(--text,#f5f5f0); font-family:inherit; font-size:14px; line-height:1.4; max-height:120px;"></textarea>
      <button id="chat-send" type="submit" style="padding:0 16px; border-radius:8px; background:var(--text,#f5f5f0); color:var(--bg,#08080a); border:none; font-weight:500; cursor:pointer; font-family:inherit;">Send</button>
    </form>
  `;

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  fab.onclick = () => {
    const open = panel.style.display === "flex";
    panel.style.display = open ? "none" : "flex";
    if (!open) {
      if (!history.length) renderGreeting();
      setTimeout(() => panel.querySelector("#chat-input")?.focus(), 60);
    }
  };
  panel.querySelector("#chat-close").onclick = () => { panel.style.display = "none"; };

  const form = panel.querySelector("#chat-form");
  const input = panel.querySelector("#chat-input");
  // Auto-grow the textarea up to its max-height
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });
  // Enter sends, Shift+Enter inserts newline
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.onsubmit = (e) => { e.preventDefault(); send(input.value.trim()); input.value = ""; input.style.height = "auto"; };
}

function renderGreeting() {
  // Local greeting bubble — no API call.
  pushAssistant(
    "Salut " + (state.user?.name || "") + ".\n\n" +
    "Je peux interroger ton portefeuille en temps réel — résumé, performance, risque, fiscalité, FIRE, stress-tests…\n\n" +
    "Essaie : *« quel est mon plus gros risque ? »*, *« combien je paierais en impôts si je vendais tout aujourd'hui ? »*, *« suis-je en avance vers le FIRE ? »*"
  );
}

function send(text) {
  if (!text || waiting) return;
  pushUser(text);
  waiting = true;
  const typing = pushAssistantTyping();
  // Build the history payload BEFORE pushing the typing placeholder would
  // have polluted it. Three things must be excluded:
  //   - the typing placeholder (last item, role=assistant, _typing=true)
  //   - the user message we just pushed (second-to-last) — sent separately
  //     in `message`, so including it here duplicates it and the API throws
  //     400 on two consecutive `user` roles
  //   - any prior assistant bubble that's actually an error/system tag
  //     (those start with "⚠" — we use `_systemError` to mark them
  //     unambiguously)
  // Keep it to the last 10 real-conversation turns.
  const hist = history
    .slice(0, -2)              // drop the typing placeholder + current user msg
    .filter(m => !m._typing && !m._systemError && (m.role === "user" || m.role === "assistant"))
    .slice(-10)                // keep the last 10 of what remains
    .map(({ role, content }) => ({ role, content }));

  API.request("/chat/ask", {
    method: "POST",
    body: { message: text, history: hist },
  }).then((res) => {
    typing.remove();
    history.pop();             // remove the typing placeholder from state
    pushAssistant(res?.reply || "(pas de réponse)", res?.tools_used);
  }).catch((err) => {
    typing.remove();
    history.pop();
    showErrorBubble(err);
  }).finally(() => { waiting = false; });
}

function showErrorBubble(err) {
  // Render an error bubble that is NOT considered part of the conversation
  // history. Without the _systemError flag, a follow-up message would ship
  // this back to the API and either look weird in the model's context or
  // (worse) get echoed back.
  let body;
  const msg = err?.message || "";
  if (msg.includes("No Anthropic API key") || msg.includes("anthropic key")) {
    body = "⚠ **Aucune clé Anthropic configurée pour ce compte.**\n\n" +
           "Pour activer le chat sur ce déploiement, l'admin pose le secret côté serveur :\n\n" +
           "`fly secrets set ANTHROPIC_API_KEY=sk-ant-...`\n\n" +
           "Ou ajoute ta propre clé dans **Settings → Clé API Anthropic**.";
  } else if (msg.startsWith("[network]")) {
    body = "⚠ **Pas de connexion au serveur.** Vérifie ton wifi puis réessaie.\n\n" +
           "Détail : `" + msg.replace("[network] ", "") + "`";
  } else if (msg.includes("rate limit")) {
    body = "⚠ **Quota Anthropic atteint.** Attends quelques secondes et réessaie.";
  } else if (msg.includes("out of credit") || msg.includes("credit balance") || msg.includes("HTTP 402")) {
    body = "⚠ **Compte Anthropic sans crédit.**\n\n" +
           "Va sur **console.anthropic.com/settings/billing** pour recharger, puis recommence.\n\n" +
           "(C'est ton compte Anthropic perso, pas un bug de l'app — la clé fonctionne, " +
           "mais l'API refuse les requêtes tant que le solde est à zéro.)";
  } else if (msg.includes("rejected") || msg.includes("invalid_api_key")) {
    body = "⚠ **Clé Anthropic rejetée.** Mets-la à jour dans **Settings**.";
  } else if (msg.includes("HTTP 50") || msg.includes("temporarily unavailable")) {
    body = "⚠ **Erreur côté serveur.**\n\n`" + msg + "`\n\n" +
           "Ouvre la console (Cmd+Option+J) si ça persiste, ou check `fly logs`.";
  } else if (!msg) {
    body = "⚠ Erreur inconnue (message vide). Ouvre la console pour le détail.";
  } else {
    body = "⚠ " + msg;
  }
  pushAssistant(body, null, /*isSystemError*/ true);
}

// ─── message rendering ───────────────────────────────────────────────

function pushUser(text) {
  history.push({ role: "user", content: text });
  const msgs = document.querySelector("#chat-msgs");
  const el = document.createElement("div");
  el.style.cssText = "align-self:flex-end; max-width:85%; padding:10px 14px; border-radius:14px 14px 4px 14px; background:var(--primary,#6b7d5e); color:var(--bg,#08080a); font-size:14px; line-height:1.45; white-space:pre-wrap; word-wrap:break-word;";
  el.textContent = text;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
}

function pushAssistant(text, toolsUsed, isSystemError) {
  // System-error bubbles are visible to the user but flagged so the next
  // turn's history filter drops them — they're not real model output.
  const entry = { role: "assistant", content: text };
  if (isSystemError) entry._systemError = true;
  history.push(entry);
  const msgs = document.querySelector("#chat-msgs");
  const wrap = document.createElement("div");
  wrap.style.cssText = "align-self:flex-start; max-width:92%;";
  const bub = document.createElement("div");
  bub.style.cssText = "padding:11px 14px; border-radius:14px 14px 14px 4px; background:var(--surface-2,#15151a); border:1px solid var(--border,rgba(255,255,255,0.08)); color:var(--text,#f5f5f0); font-size:14px; line-height:1.55;";
  bub.innerHTML = renderMarkdown(text);
  wrap.appendChild(bub);
  if (toolsUsed && toolsUsed.length) {
    const tag = document.createElement("div");
    tag.style.cssText = "margin-top:6px; font-family:var(--font-mono,'Geist Mono',monospace); font-size:10px; color:var(--text-muted,#8c8c87); letter-spacing:0.06em;";
    tag.textContent = "↳ used: " + toolsUsed.map(t => t.name).join(" · ");
    wrap.appendChild(tag);
  }
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
}

function pushAssistantTyping() {
  history.push({ role: "assistant", content: "…", _typing: true });
  const msgs = document.querySelector("#chat-msgs");
  const el = document.createElement("div");
  el.style.cssText = "align-self:flex-start; padding:11px 14px; border-radius:14px 14px 14px 4px; background:var(--surface-2,#15151a); border:1px solid var(--border,rgba(255,255,255,0.08)); color:var(--text-muted,#8c8c87); font-size:14px;";
  el.innerHTML = `<span style="display:inline-flex;gap:4px;align-items:center;"><span class="ct-dot"></span><span class="ct-dot" style="animation-delay:0.2s"></span><span class="ct-dot" style="animation-delay:0.4s"></span></span>`;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  if (!document.getElementById("chat-typing-css")) {
    const css = document.createElement("style");
    css.id = "chat-typing-css";
    css.textContent = `.ct-dot{width:6px;height:6px;border-radius:50%;background:var(--text-muted,#8c8c87);animation:ctp 1.1s infinite ease-in-out;}@keyframes ctp{0%,60%,100%{transform:translateY(0);opacity:0.35;}30%{transform:translateY(-3px);opacity:1;}}`;
    document.head.appendChild(css);
  }
  return el;
}

// Minimal Markdown renderer — handles paragraphs, **bold**, *italic*,
// `code`, line breaks, and dash-prefixed lists. Everything is escapeHtml-ed
// FIRST so user-controlled (or model-controlled) input can't inject HTML.
function renderMarkdown(text) {
  const safe = escapeHtml(text);
  const paragraphs = safe.split(/\n{2,}/).map((p) => {
    // List?
    const lines = p.split("\n");
    if (lines.every((l) => /^\s*-\s+/.test(l))) {
      const items = lines.map((l) => "<li>" + inline(l.replace(/^\s*-\s+/, "")) + "</li>").join("");
      return `<ul style="margin:6px 0 6px 18px; padding:0;">${items}</ul>`;
    }
    return `<p style="margin:0 0 8px;">${inline(p.replace(/\n/g, "<br>"))}</p>`;
  }).join("");
  return paragraphs;
}
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code style="font-family:var(--font-mono,monospace);background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:4px;font-size:12.5px;">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?)]|$)/g, '$1<em style="font-family:var(--font-serif,\'Instrument Serif\',Georgia,serif);font-style:italic;">$2</em>');
}
