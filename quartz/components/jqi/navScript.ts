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
  sync();
})();
`
