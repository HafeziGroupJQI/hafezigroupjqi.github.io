// A member's first name, for the header when the full name doesn't fit the desktop row.
// Source text, because the header's script is inlined in every page (tested in nav.test.ts).
export const shortNameSource = `function shortName(name) {
    return String(name == null ? "" : name).trim().split(/\\s+/)[0] || "";
  }`

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
  // Signed in, "Sign out" gets the member's photo and name before it, linking to /settings: the
  // name and photo they chose there (the session's display_name and avatar), else GitHub's.
  // The name is shown in full, never cut with an ellipsis. Only on the desktop row, and only when
  // the full name would push the row onto another line or past its edge, the first name stands in.
  ${shortNameSource}
  function fitName() {
    var chip = document.querySelector(".nav-identity");
    var list = document.querySelector(".site-header__nav > ul");
    if (!chip || !list) return;
    var name = chip.querySelector(".nav-name");
    var full = chip.dataset.full || "";
    var first = shortName(full);
    name.textContent = full;
    if (!desktop.matches || !first || first === full) return;
    name.textContent = first;
    var height = list.offsetHeight;
    name.textContent = full;
    if (list.offsetHeight > height || list.scrollWidth > list.clientWidth) name.textContent = first;
  }
  function setName(chip, full) {
    chip.dataset.full = full;
    var label = full + ": your settings (" + (chip.dataset.login || "") + ")";
    chip.title = label;
    chip.setAttribute("aria-label", label);
    fitName();
  }
  var fitting = 0;
  function refit() {
    cancelAnimationFrame(fitting);
    fitting = requestAnimationFrame(fitName);
  }
  window.addEventListener("resize", refit);
  desktop.addEventListener("change", refit);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);
  function identity(user) {
    var out = document.querySelector('[data-auth="out"]');
    if (!out) return;
    var chip = out.querySelector(".nav-identity");
    if (!user) { if (chip) chip.remove(); return; }
    if (!chip) {
      chip = document.createElement("a");
      chip.className = "nav-identity";
      chip.href = "/settings";
      var pic = document.createElement("img");
      pic.className = "nav-avatar";
      pic.alt = "";
      pic.width = 24;
      pic.height = 24;
      // An uploaded photo that fails to load (say, a stale link) falls back to GitHub's avatar.
      pic.addEventListener("error", function () {
        var fallback = "https://avatars.githubusercontent.com/" + encodeURIComponent(chip.dataset.login || "") + "?s=48";
        if (pic.src !== fallback) pic.src = fallback;
      });
      var name = document.createElement("span");
      name.className = "nav-name";
      chip.append(pic, name);
      out.prepend(chip);
    }
    chip.dataset.login = user.login;
    var avatar = user.avatar || "https://avatars.githubusercontent.com/" + encodeURIComponent(user.login) + "?s=48";
    var img = chip.querySelector("img");
    if (img.getAttribute("src") !== avatar) img.src = avatar;
    setName(chip, user.display_name || user.name || user.login);
  }
  // /settings announces a new name or photo as soon as it is saved.
  window.addEventListener("hafezi:identity", function (event) {
    var chip = document.querySelector(".nav-identity");
    if (!chip || !event.detail) return;
    if (event.detail.display_name) setName(chip, event.detail.display_name);
    if (event.detail.avatar) chip.querySelector("img").src = event.detail.avatar;
  });
  function applyAuth(loggedIn, login, isAdmin, user) {
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
      document.querySelectorAll('[data-auth="out"] > a:not(.nav-identity)').forEach(function (a) {
        a.textContent = "Sign out";
        a.title = "Sign out (" + login + ")";
      });
    identity(loggedIn && user ? user : null);
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
      .then(function (s) { applyAuth(!!(s && s.user), s && s.user && s.user.login, s && s.user && s.user.is_admin, s && s.user); })
      .catch(function () { applyAuth(false); });
  }
  document.addEventListener("nav", updateAuthNav);
  updateAuthNav();
  sync();
})();
`
