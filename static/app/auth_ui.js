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
