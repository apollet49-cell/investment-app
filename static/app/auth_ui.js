// Auth screen + landing v2 wiring. The HTML for the landing is
// pre-rendered in index.html for instant FCP — JS only attaches the
// interactive bits (demo CTAs, sign-in modal, scroll reveals, menu).
// Sign-in is one shared modal that swaps between "login" and "register"
// modes via a small state flag.
import { API, escapeHtml, state, toast, track, bootApp } from "/static/app.js";

let _signinMode = "login";
let _landingWired = false;

export function showAuth() {
  document.getElementById("app-shell").classList.add("hidden");
  const authScreen = document.getElementById("auth-screen");
  authScreen.classList.remove("hidden");
  // Document body should scroll the landing freely (the app-shell sets
  // overflow:hidden when active for the fixed sidebar layout).
  document.body.style.overflow = "";
  wireLandingV2();
}

function wireLandingV2() {
  if (_landingWired) return;
  _landingWired = true;

  // Demo CTAs — every button/link with data-action="demo" triggers
  // POST /auth/demo and boots straight into the app.
  document.querySelectorAll('[data-action="demo"]').forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `Setting up your demo…`;
      try {
        const data = await API.request("/auth/demo", { method: "POST" });
        state.token = data.access_token;
        state.user = data.user;
        localStorage.setItem("token", state.token);
        track("demo_login");
        bootApp().catch(err => toast(err.message || "Something went wrong", "error"));
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = original;
        toast(err.message || "Demo unavailable, try again", "error");
      }
    });
  });

  // Sign-in modal triggers
  document.querySelectorAll('[data-action="signin"]').forEach((el) => {
    el.addEventListener("click", (ev) => { ev.preventDefault(); openSigninModal("login"); });
  });

  // Sticky-nav scrolled state — adds a thin border under the nav once
  // the page has scrolled past the hero.
  const lvNav = document.getElementById("lv-nav");
  if (lvNav) {
    const onScroll = () => {
      if (window.scrollY > 6) lvNav.classList.add("is-scrolled");
      else lvNav.classList.remove("is-scrolled");
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // Apple-style dropdown menu: trigger toggles the panel + backdrop,
  // clicking an item smooth-scrolls to its section + closes the panel,
  // Escape and outside-click also close.
  const menuTrigger = document.getElementById("lv-menu-trigger");
  const menuPanel = document.getElementById("lv-menu-panel");
  const menuBackdrop = document.getElementById("lv-menu-backdrop");
  if (menuTrigger && menuPanel) {
    const setMenuOpen = (open) => {
      menuPanel.classList.toggle("is-open", open);
      menuBackdrop?.classList.toggle("is-open", open);
      menuTrigger.setAttribute("aria-expanded", String(open));
    };
    menuTrigger.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const isOpen = menuPanel.classList.contains("is-open");
      setMenuOpen(!isOpen);
    });
    menuBackdrop?.addEventListener("click", () => setMenuOpen(false));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && menuPanel.classList.contains("is-open")) setMenuOpen(false);
    });
    menuPanel.querySelectorAll("[data-menu-link]").forEach((link) => {
      link.addEventListener("click", (ev) => {
        const href = link.getAttribute("href");
        if (href && href.startsWith("#")) {
          ev.preventDefault();
          setMenuOpen(false);
          const target = document.querySelector(href);
          if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    });
  }

  // Reveal-on-scroll for sections — adds .is-in when each section enters
  // the viewport. CSS handles the fade+rise.
  const reveals = document.querySelectorAll("#auth-screen.landing-v2 .lv-sec-head, #auth-screen.landing-v2 .lv-compare, #auth-screen.landing-v2 .lv-bench-card, #auth-screen.landing-v2 .lv-env, #auth-screen.landing-v2 .lv-dvf-card, #auth-screen.landing-v2 .lv-review-card, #auth-screen.landing-v2 .lv-stat, #auth-screen.landing-v2 .lv-price, #auth-screen.landing-v2 .lv-cta-h");
  reveals.forEach((el) => el.classList.add("lv-reveal"));
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add("is-in"));
  }

  // Hero chart range buttons (1M / 3M / YTD / 1Y / ALL): clicking swaps
  // the SVG paths + legend percentages + the TWR floating card so the
  // marketing chart "comes to life". Pure illustrative data — the landing
  // has no authenticated user yet; the goal is to show the product feels
  // interactive at first glance.
  wireHeroRangeButtons();

  // Sign-in modal — form submit, close, switch register/login
  const overlay = document.getElementById("signin-modal-overlay");
  const form = document.getElementById("signin-form");
  const errEl = document.getElementById("signin-error");
  document.querySelectorAll('[data-action="signin-close"]').forEach((el) => {
    el.addEventListener("click", closeSigninModal);
  });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSigninModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) closeSigninModal();
  });
  document.querySelectorAll('[data-action="signin-register"]').forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      _signinMode = _signinMode === "login" ? "register" : "login";
      renderSigninModeUI();
    });
  });
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    errEl.textContent = "";
    const fd = new FormData(ev.target);
    const payload = Object.fromEntries(fd.entries());
    const submitBtn = form.querySelector(".signin-btn");
    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Working…";
    try {
      const path = _signinMode === "login" ? "/auth/login" : "/auth/register";
      // Register endpoint expects a name — we use the email's local part
      // when in register mode (the landing flow is auto-named).
      if (_signinMode === "register" && !payload.name) {
        payload.name = (payload.email || "").split("@")[0] || "Investor";
      }
      const data = await API.request(path, { method: "POST", body: payload });
      if (!data || !data.access_token || !data.user) {
        throw new Error("Invalid response from server");
      }
      state.token = data.access_token;
      state.user = data.user;
      localStorage.setItem("token", state.token);
      track(_signinMode === "login" ? "user_login" : "user_register", { currency: data.user?.currency });
      closeSigninModal();
      bootApp().catch((err) => toast(err.message || "Boot error", "error"));
    } catch (err) {
      errEl.textContent = err.message || "Sign-in failed";
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  };
}

// Illustrative datasets for the hero chart's 5 range buttons. Curves go
// progressively higher (= portfolio beats benchmark over every window),
// matching the landing's "honest XIRR" narrative. SVG viewBox is
// "0 0 600 260" — y decreases upward, so smaller values = higher line.
const HERO_RANGE_DATA = {
  "1M": {
    port:  "M0,190 C50,188 100,184 150,182 C200,180 250,184 300,180 C350,176 400,174 450,172 C500,168 550,166 600,162",
    bench: "M0,188 C50,187 100,186 150,184 C200,183 250,182 300,182 C350,180 400,179 450,178 C500,176 550,174 600,172",
    dotY: 162, portPct: "+ 2.3 %",  benchPct: "+ 1.4 %",  twrLabel: "TWR · 1M",  twrValue: "2.10",
  },
  "3M": {
    port:  "M0,205 C50,200 100,192 150,188 C200,180 250,170 300,168 C350,158 400,150 450,140 C500,130 550,122 600,115",
    bench: "M0,200 C50,198 100,194 150,189 C200,185 250,180 300,177 C350,170 400,165 450,160 C500,155 550,150 600,145",
    dotY: 115, portPct: "+ 5.8 %",  benchPct: "+ 3.7 %",  twrLabel: "TWR · 3M",  twrValue: "5.40",
  },
  "YTD": {
    port:  "M0,215 C50,208 100,198 150,186 C200,170 250,158 300,145 C350,128 400,115 450,100 C500,90 550,80 600,70",
    bench: "M0,210 C50,205 100,196 150,186 C200,178 250,172 300,162 C350,150 400,140 450,130 C500,122 550,115 600,108",
    dotY: 70,  portPct: "+ 9.5 %",  benchPct: "+ 6.2 %",  twrLabel: "TWR · YTD", twrValue: "8.90",
  },
  "1Y": {
    port:  "M0,210 C40,205 80,195 120,180 C160,165 200,170 240,150 C280,130 320,140 360,108 C400,80 440,90 480,62 C520,38 560,46 600,28",
    bench: "M0,180 C40,178 80,170 120,168 C160,166 200,160 240,158 C280,156 320,150 360,144 C400,138 440,130 480,128 C520,126 560,118 600,116",
    dotY: 28,  portPct: "+ 18.4 %", benchPct: "+ 11.2 %", twrLabel: "TWR · 1Y",  twrValue: "12.81",
  },
  "ALL": {
    port:  "M0,240 C50,232 100,218 150,200 C200,182 250,165 300,140 C350,118 400,95 450,72 C500,52 550,32 600,18",
    bench: "M0,235 C50,228 100,218 150,205 C200,192 250,178 300,162 C350,148 400,132 450,118 C500,102 550,88 600,72",
    dotY: 18,  portPct: "+ 47.1 %", benchPct: "+ 28.6 %", twrLabel: "TWR · ALL", twrValue: "37.20",
  },
};

function wireHeroRangeButtons() {
  const buttons = Array.from(document.querySelectorAll("#auth-screen .lv-r-btn"));
  if (!buttons.length) return;
  const portPath  = document.querySelector("#auth-screen .lv-line-port");
  const benchPath = document.querySelector("#auth-screen .lv-line-bench");
  const areaPath  = document.querySelector("#auth-screen .lv-line-area");
  const dot       = document.querySelector("#auth-screen .lv-end-dot");
  const pulse     = document.querySelector("#auth-screen .lv-end-pulse");
  const legs      = document.querySelectorAll("#auth-screen .lv-leg");
  const portPct   = legs[0]?.lastElementChild;
  const benchPct  = legs[1]?.lastElementChild;
  const twrLabel  = document.querySelector("#auth-screen .lv-float-twr .lv-fc-label");
  const twrValue  = document.querySelector("#auth-screen .lv-float-twr .lv-fc-value");

  const apply = (key) => {
    const d = HERO_RANGE_DATA[key];
    if (!d) return;
    if (portPath)  portPath.setAttribute("d", d.port);
    if (benchPath) benchPath.setAttribute("d", d.bench);
    // Area = the portfolio line closed back down to the chart bottom.
    if (areaPath)  areaPath.setAttribute("d", `${d.port} L600,260 L0,260 Z`);
    if (dot)   dot.setAttribute("cy", String(d.dotY));
    if (pulse) pulse.setAttribute("cy", String(d.dotY));
    if (portPct)  portPct.textContent = d.portPct;
    if (benchPct) benchPct.textContent = d.benchPct;
    if (twrLabel) twrLabel.textContent = d.twrLabel;
    if (twrValue) twrValue.innerHTML = `${d.twrValue} <span class="lv-pct">%</span>`;
  };

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.toggle("is-active", b === btn));
      apply(btn.textContent.trim());
    });
  });
}

function openSigninModal(mode = "login") {
  _signinMode = mode;
  renderSigninModeUI();
  const overlay = document.getElementById("signin-modal-overlay");
  overlay.classList.add("open");
  setTimeout(() => document.getElementById("signin-email")?.focus(), 50);
}

function closeSigninModal() {
  document.getElementById("signin-modal-overlay")?.classList.remove("open");
  document.getElementById("signin-error").textContent = "";
}

function renderSigninModeUI() {
  const isLogin = _signinMode === "login";
  document.getElementById("signin-h").textContent = isLogin ? "Sign in" : "Create your account";
  const subP = document.querySelector(".signin-modal p");
  if (subP) subP.textContent = isLogin
    ? "Welcome back to your investment workspace."
    : "Get a private workspace for your portfolio.";
  document.querySelector(".signin-btn").textContent = isLogin ? "Sign in" : "Create account";
  const switchEl = document.querySelector(".signin-switch");
  if (switchEl) {
    switchEl.innerHTML = isLogin
      ? 'No account yet? <a data-action="signin-register">Register</a>'
      : 'Already have an account? <a data-action="signin-register">Sign in</a>';
    switchEl.querySelector('[data-action="signin-register"]').addEventListener("click", (ev) => {
      ev.preventDefault();
      _signinMode = _signinMode === "login" ? "register" : "login";
      renderSigninModeUI();
    });
  }
}
