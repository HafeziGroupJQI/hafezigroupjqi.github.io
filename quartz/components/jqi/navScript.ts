// Mobile menu toggle and search shortcut for the JQI header. Inlined by JqiFrame;
// a document-level listener so it survives SPA navigation.
export const navScript = `(function () {
  // stop the explorer from scrolling the whole page to its active item on first load
  try { if (sessionStorage.getItem("explorerScrollTop") === null) sessionStorage.setItem("explorerScrollTop", "0"); } catch (e) {}
  if (window.__jqiNavBound) return;
  window.__jqiNavBound = true;
  var desktop = window.matchMedia("(min-width: 1200px)");
  function sync() {
    var nav = document.querySelector(".site-header__nav");
    var toggle = document.querySelector("[data-jqi-nav-toggle]");
    if (!nav || !toggle) return;
    nav.setAttribute("aria-hidden", desktop.matches ? "false" : String(toggle.getAttribute("aria-expanded") !== "true"));
  }
  document.addEventListener("click", function (e) {
    var toggle = e.target.closest("[data-jqi-nav-toggle]");
    if (toggle) {
      toggle.setAttribute("aria-expanded", String(toggle.getAttribute("aria-expanded") !== "true"));
      sync();
    }
    if (e.target.closest("[data-jqi-search]")) {
      var btn = document.querySelector(".search .search-button");
      if (btn) btn.click();
    }
  });
  desktop.addEventListener("change", sync);
  document.addEventListener("nav", function () {
    var toggle = document.querySelector("[data-jqi-nav-toggle]");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
    sync();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") document.querySelectorAll(".member-menu[open]").forEach(function (menu) { menu.open = false; menu.querySelector("summary").focus(); });
  });
  document.addEventListener("click", function (event) {
    document.querySelectorAll(".member-menu[open]").forEach(function (menu) { if (!menu.contains(event.target)) menu.open = false; });
    if (event.target.closest('a[href="/auth/logout"]')) { sessionStorage.clear(); }
    var login = event.target.closest('a[href$="/auth/login"]');
    if (login) login.href = login.href.split("?")[0] + "?next=" + encodeURIComponent(location.pathname + location.search);
  });
  window.addEventListener("pageshow", function (event) { if (event.persisted) location.reload(); });
  // One unified site keyed on the live session: reveal member entries ([data-member]) and "Sign
  // out" ([data-auth="out"]) and hide "Sign in" ([data-auth="in"]) when /api/session returns a
  // user; do the reverse when logged out. Degrades to the logged-out default where there is no API
  // (e.g. the GitHub Pages public deployment), so nothing member-only ever leaks into the markup.
  function applyAuth(loggedIn, login, isAdmin) {
    document.body.classList.toggle("is-authed", !!loggedIn);
    document.querySelectorAll('[data-member], [data-auth="out"]').forEach(function (el) {
      if (loggedIn) el.removeAttribute("hidden"); else el.setAttribute("hidden", "");
    });
    document.querySelectorAll('[data-auth="in"]').forEach(function (el) {
      if (loggedIn) el.setAttribute("hidden", ""); else el.removeAttribute("hidden");
    });
    document.querySelectorAll("[data-admin-only]").forEach(function (el) {
      if (loggedIn && isAdmin) el.removeAttribute("hidden"); else el.setAttribute("hidden", "");
    });
    if (loggedIn && login)
      document.querySelectorAll('[data-auth="out"] > a').forEach(function (a) {
        a.textContent = "Sign out (" + login + ")";
      });
  }
  // Called directly and on Quartz's "nav" event, which also fires once on a plain page load: ask
  // once per URL. Only the members service worker answers /api/session; without it the request
  // reaches GitHub Pages and 404s, which already means signed out.
  var authFor = null;
  function updateAuthNav() {
    if (authFor === location.href) return;
    authFor = location.href;
    if (!(navigator.serviceWorker && navigator.serviceWorker.controller)) return applyAuth(false);
    fetch("/api/session", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { applyAuth(!!(s && s.user), s && s.user && s.user.login, s && s.user && s.user.is_admin); })
      .catch(function () { applyAuth(false); });
  }
  document.addEventListener("nav", updateAuthNav);
  updateAuthNav();
  sync();
})();
`
