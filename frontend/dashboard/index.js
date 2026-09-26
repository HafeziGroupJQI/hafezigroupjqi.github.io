// The /devices dashboard: one page, six tabs, one store, one EventSource. mountDashboard() is the
// only DOM entry; member-tools.js calls it with its api() (CSRF + 401 → login) and the session.
//
// Data cadence (fits N lab PCs × M viewers): the fleet list polls every 10 s (60 s hidden); the
// focused device gets one SSE stream plus slow refetches; experiments poll 15 s while any is
// active; activity polls 15 s. A 1 s tick re-derives liveness from the server's heartbeat age.

import { h, setText } from "./dom.js"
import { LAYOUTS, TABS, TAB_LABELS, buildHref, parseRoute } from "./router.js"
import { createPoller } from "./scheduler.js"
import { createStore, initialState } from "./store.js"
import { openDeviceStream } from "./stream.js"
import { mountActivity } from "./views/activity.js"
import { mountBuilder } from "./views/builder.js"
import { mountDevice } from "./views/device.js"
import { mountExperiments } from "./views/experiments.js"
import { mountInstruments } from "./views/instruments.js"
import { LAYOUT_LABELS, fleetSummary, mountOverview } from "./views/overview.js"

const VIEWS = {
  overview: mountOverview,
  device: mountDevice,
  instruments: mountInstruments,
  experiments: mountExperiments,
  activity: mountActivity,
  builder: mountBuilder,
}
const HIDDEN_PAUSE_MS = 60_000

export function mountDashboard(root, { api, session }) {
  const isOwner = session.user?.role === "owner"
  const store = createStore(initialState(Date.now()))
  const isHidden = () => document.visibilityState === "hidden"
  let route = parseRoute(location.search)
  let view = null
  let stream = null
  let devicesFetchedAt = Date.now()
  let hiddenTimer = null
  const enc = encodeURIComponent

  // ---- chrome ----
  root.replaceChildren()
  root.classList.add("dashboard")
  const summary = h("p", { class: "dash-summary", "aria-live": "polite" })
  const header = h("header", { class: "dash-header" },
    h("h1", { class: "dash-title", text: "Lab devices" }), summary, h("span", { class: "spacer" }),
    isOwner ? h("button", { type: "button", class: "primary", text: "Add device", onclick: () => addDevice() }) : null)
  const tabs = h("div", { class: "dash-tabs", role: "tablist", "aria-label": "Dashboard sections" })
  const toolbar = h("div", { class: "dash-toolbar" })
  const banner = h("div", { class: "dash-error", role: "alert", hidden: true })
  const panel = h("div", { class: "dash-panel", role: "tabpanel", id: "dash-panel", tabindex: "-1" })
  root.append(header, tabs, toolbar, banner, panel)

  for (const tab of TABS)
    tabs.append(h("button", {
      type: "button", role: "tab", id: `dash-tab-${tab}`, "aria-controls": "dash-panel", "data-tab": tab, text: TAB_LABELS[tab],
      onclick: () => navigate({ tab, code: route.code }),
    }))
  tabs.addEventListener("keydown", (event) => {
    const i = TABS.indexOf(route.tab)
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[event.key]
    if (next == null) return
    event.preventDefault()
    const tab = TABS[(next + TABS.length) % TABS.length]
    navigate({ tab, code: route.code })
    tabs.querySelector(`[data-tab="${tab}"]`).focus()
  })

  // ---- data ----
  const showError = (error) => {
    banner.hidden = false
    banner.replaceChildren(h("span", { text: error.message }), h("button", { type: "button", text: "Retry", onclick: () => ((banner.hidden = true), refreshAll()) }))
  }
  async function loadDevices() {
    try {
      const devices = await api("/api/devices")
      devicesFetchedAt = Date.now()
      store.dispatch({ type: "devicesLoaded", devices, at: devicesFetchedAt })
      banner.hidden = true
    } catch (error) {
      showError(error)
    }
  }
  async function loadDevice(code) {
    const [device, instruments] = await Promise.all([api(`/api/devices/${enc(code)}`), api(`/api/devices/${enc(code)}/instruments`)])
    store.dispatch({ type: "deviceLoaded", code, device, at: Date.now() })
    store.dispatch({ type: "instrumentsLoaded", code, instruments })
  }
  const loadInstruments = async (code) =>
    store.dispatch({ type: "instrumentsLoaded", code, instruments: await api(`/api/devices/${enc(code)}/instruments`) })
  const loadCommands = async (code) =>
    store.dispatch({ type: "commandsLoaded", code, commands: await api(`/api/devices/${enc(code)}/commands`) })
  async function loadExperiments(code) {
    if (code) {
      const rows = await api(`/api/devices/${enc(code)}/experiments`)
      return store.dispatch({ type: "experimentsLoaded", code, experiments: rows.map((r) => ({ ...r, device_code: code })) })
    }
    const devices = [...store.getState().devices.keys()]
    const lists = await Promise.all(devices.map((c) =>
      api(`/api/devices/${enc(c)}/experiments`).then((rows) => rows.map((r) => ({ ...r, device_code: c }))).catch(() => [])))
    store.dispatch({ type: "experimentsLoaded", code: null, experiments: lists.flat() })
  }
  const guard = (promise) => promise.catch(showError)

  // Per-tab refresh; experiments slow down to 60 s when nothing is running.
  let lastExperimentsFetch = 0
  async function tabRefresh() {
    const code = route.code
    switch (route.tab) {
      case "device":
        if (code) await guard(loadDevice(code))
        break
      case "instruments":
        if (code) await guard(loadInstruments(code))
        break
      case "activity":
        if (code) await guard(loadCommands(code))
        break
      case "experiments": {
        const rows = store.getState().experiments.get(code ?? "*")
        const active = rows?.some((r) => r.status === "running" || r.status === "generating")
        if (!rows || active || Date.now() - lastExperimentsFetch > 60_000) {
          lastExperimentsFetch = Date.now()
          if (!code && !store.getState().devicesLoaded) await loadDevices()
          await guard(loadExperiments(code))
        }
        break
      }
      case "overview": {
        const focus = view?.streamCode?.()
        if (focus) await guard(loadInstruments(focus))
        break
      }
    }
  }
  const devicesPoller = createPoller(loadDevices, 10_000, { isHidden })
  let tabPoller = null
  const tabInterval = () => ({ device: 60_000, instruments: 60_000, overview: 60_000 })[route.tab] ?? 15_000

  function refreshAll() {
    devicesPoller.now()
    tabPoller?.now()
  }

  // ---- actions (shared with the views) ----
  async function command(code, kind, args, button) {
    const label = button?.textContent
    if (button) {
      button.disabled = true
      button.textContent = "Sending…"
    }
    try {
      const { delivered } = await api(`/api/devices/${enc(code)}/commands`, { method: "POST", body: JSON.stringify({ kind, args }) })
      if (button) button.textContent = delivered ? "Sent" : "Queued"
      guard(loadCommands(code))
    } catch (error) {
      showError(error)
    } finally {
      if (button) setTimeout(() => ((button.disabled = false), (button.textContent = label)), 1500)
    }
  }
  async function pollAll(code, button) {
    // The agent polls one named instrument per command, so fan out over the declared set.
    try {
      button && (button.disabled = true)
      const instruments = await api(`/api/devices/${enc(code)}/instruments`)
      await Promise.all(instruments.map((i) =>
        api(`/api/devices/${enc(code)}/commands`, { method: "POST", body: JSON.stringify({ kind: "poll", args: { local_id: i.local_id } }) })))
      if (button) button.textContent = `Polled ${instruments.length}`
    } catch (error) {
      showError(error)
    } finally {
      if (button) setTimeout(() => ((button.disabled = false), (button.textContent = "Poll all")), 1500)
    }
  }
  async function stopExperiment(code, id, button) {
    if (button) button.disabled = true
    try {
      await api(`/api/devices/${enc(code)}/experiments/${enc(id)}/stop`, { method: "POST" })
      lastExperimentsFetch = 0
      tabPoller?.now()
    } catch (error) {
      if (button) button.disabled = false
      showError(error)
    }
  }
  async function revokeDevice(code) {
    if (!confirm(`Revoke ${code}? Its agent is cut off at once; Add device with the same name to re-enrol it.`)) return
    try {
      await api(`/api/devices/${enc(code)}`, { method: "DELETE" })
      await loadDevices()
      navigate({ tab: "overview" })
    } catch (error) {
      showError(error)
    }
  }
  const loadInstrument = (code, id) =>
    guard(api(`/api/devices/${enc(code)}/instruments/${enc(id)}`).then((detail) => store.dispatch({ type: "instrumentLoaded", code, detail })))

  function addDevice() {
    const dialog = h("dialog", { class: "member-editor" })
    document.body.append(dialog)
    dialog.innerHTML = `<h2>Add a device</h2>
      <form>
        <p class="muted">Adding a name that is pending or revoked issues it a fresh token.</p>
        <label>Device code-name (lowercase letters, digits, hyphens)<input name="code_name" required maxlength="64" pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?" autocomplete="off"></label>
        <p role="alert"></p>
        <div class="editor-actions"><button type="submit">Create &amp; get token</button><button type="button" data-cancel>Cancel</button></div>
      </form>
      <div data-result hidden></div>`
    const form = dialog.querySelector("form")
    dialog.querySelector("[data-cancel]").onclick = () => dialog.close()
    dialog.addEventListener("close", () => dialog.remove())
    form.onsubmit = async (event) => {
      event.preventDefault()
      const code_name = form.elements.namedItem("code_name").value.trim()
      try {
        const created = await api("/api/devices", { method: "POST", body: JSON.stringify({ code_name }) })
        const result = dialog.querySelector("[data-result]")
        form.hidden = true
        result.hidden = false
        result.append(
          h("p", {}, "Device ", h("code", { text: created.code_name }), " created. Enroll the agent once with this one-time token (shown only now, valid 15 minutes):"),
          h("pre", { class: "enroll-token", text: created.enrollment_token }),
          h("p", { class: "muted" }, "On the lab PC (elevated): ", h("code", { text: `HafeziAgent.exe enroll ${created.enrollment_token}` })),
          h("div", { class: "editor-actions" }, h("button", { type: "button", text: "Done", onclick: () => (dialog.close(), loadDevices()) })),
        )
      } catch (error) {
        form.querySelector('[role="alert"]').textContent = error.message
      }
    }
    dialog.showModal()
  }

  const ctx = {
    store, api, isOwner, navigate, command, pollAll, stopExperiment, loadInstrument, addDevice, revokeDevice,
    devicesFetchedAt: () => devicesFetchedAt,
  }

  // ---- routing ----
  function navigate(partial, { replace = false } = {}) {
    const href = buildHref(partial)
    const next = parseRoute(href.split("?")[1] ?? "")
    const sameTab = next.tab === route.tab
    if (href !== location.pathname + location.search)
      history[replace ? "replaceState" : "pushState"](null, "", href)
    route = next
    render()
    if (!sameTab) panel.focus({ preventScroll: true })
  }
  window.addEventListener("popstate", () => {
    route = parseRoute(location.search)
    render()
  })
  root.addEventListener("click", (event) => {
    const a = event.target.closest("a[data-nav]")
    if (!a || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const url = new URL(a.href, location.origin)
    if (url.pathname !== "/devices") return
    event.preventDefault()
    const r = parseRoute(url.search)
    navigate(r, { replace: r.tab === route.tab && r.tab === "overview" && r.layout !== route.layout })
  })

  function renderToolbar() {
    toolbar.replaceChildren()
    if (route.tab !== "overview") return
    const group = h("div", { class: "seg", role: "radiogroup", "aria-label": "Layout" })
    for (const layout of LAYOUTS)
      group.append(h("button", {
        type: "button", role: "radio", "aria-checked": String(route.layout === layout), text: LAYOUT_LABELS[layout],
        onclick: () => navigate({ ...route, layout }, { replace: true }),
      }))
    toolbar.append(group)
    if (route.layout === "wall")
      toolbar.append(h("button", { type: "button", class: "wall-exit", text: "Exit wall (Esc)", onclick: () => navigate({ ...route, layout: "grid" }, { replace: true }) }))
  }

  function syncStream() {
    const want = view?.streamCode?.() ?? null
    if (stream?.code === want) return
    stream?.close()
    stream = null
    if (want) {
      stream = openDeviceStream(want, store.dispatch)
      if (!store.getState().instruments.has(want)) guard(loadInstruments(want))
      if (isHidden()) stream.pause()
    }
  }

  function render() {
    for (const button of tabs.querySelectorAll("[role=tab]")) {
      const selected = button.dataset.tab === route.tab
      button.setAttribute("aria-selected", String(selected))
      button.tabIndex = selected ? 0 : -1
    }
    panel.setAttribute("aria-labelledby", `dash-tab-${route.tab}`)
    document.querySelector(".site-dashboard")?.classList.toggle("dash-wall", route.layout === "wall")
    document.title = `${TAB_LABELS[route.tab]}${route.code ? " · " + route.code : ""} · Lab devices`
    renderToolbar()
    view?.destroy?.()
    panel.replaceChildren()
    view = VIEWS[route.tab](panel, ctx, route)
    view.update(store.getState())
    tabPoller?.stop()
    tabPoller = createPoller(tabRefresh, tabInterval(), { isHidden })
    tabPoller.start()
    syncStream()
  }

  store.subscribe((state, prev, action) => {
    const s = fleetSummary([...state.devices.values()])
    setText(summary, state.devicesLoaded ? s.text : "Loading…")
    view?.update(state)
    if (action.type === "devicesLoaded" && route.layout === "focus") syncStream()
    if (action.type === "commandResult") {
      guard(loadInstruments(action.code))
      if (route.tab === "activity") guard(loadCommands(action.code))
    }
  })

  // ---- clocks, visibility, teardown ----
  const ticker = setInterval(() => store.dispatch({ type: "tick", now: Date.now() }), 1000)
  document.addEventListener("visibilitychange", () => {
    devicesPoller.visibilityChanged()
    tabPoller?.visibilityChanged()
    clearTimeout(hiddenTimer)
    if (isHidden()) hiddenTimer = setTimeout(() => stream?.pause(), HIDDEN_PAUSE_MS)
    else stream?.resume()
  })
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && route.layout === "wall") navigate({ ...route, layout: "grid" }, { replace: true })
  })
  window.addEventListener("beforeunload", () => {
    clearInterval(ticker)
    stream?.close()
  })

  setText(summary, "Loading…")
  devicesPoller.start()
  render()
  return { store, navigate, get route() { return route } }
}
