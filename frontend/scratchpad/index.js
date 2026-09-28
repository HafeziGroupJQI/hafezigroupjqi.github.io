// The /scratchpad page: live Jupyter/IPython/Quarto/Wolfram on the lab's compute host. The lab
// itself is an iframe on its own origin (the Worker's, /lab/<ticket>/jupyter/user/<login>/lab), so
// code running in it can never reach this site or the members token; the two talk only through
// postMessage with explicit origins. This page shows host status, starts and stops the member's
// server, and launches consoles and documents into the iframe.
// member-tools.js lazy-loads mountScratchpad() with its api() (JSON + 401 → login) and the session.

import { h, present, setText } from "../dashboard/dom.js"
import { openGpt } from "../gpt/launcher.js"
import { gptContext, insertMessage } from "./gpt.js"
import {
  LAUNCHERS,
  PROFILES,
  createNdjsonParser,
  describeStatus,
  formatMemory,
  launchUrl,
  requestedFork,
  requestedPath,
} from "./launch.js"

const POLL_MS = 15_000

export function mountScratchpad(root, { api, session }) {
  const login = session.user.login.toLowerCase()
  const isOwner = session.user.role === "owner"
  let status = null
  let busy = false

  // ---- chrome ----
  root.replaceChildren()
  const pill = h("span", { class: "status status-pending", text: "checking…" })
  const stop = h("button", {
    type: "button",
    hidden: true,
    class: "danger",
    text: "Stop server",
    onclick: () => stopServer(),
  })
  const restart = h("button", {
    type: "button",
    hidden: true,
    text: "Restart",
    onclick: () => restartServer(),
  })
  const newTab = h("a", {
    hidden: true,
    class: "btn",
    target: "_blank",
    rel: "noopener",
    text: "Open in new tab",
  })
  const header = h(
    "header",
    { class: "dash-header" },
    h("h1", { class: "dash-title", text: "Scratchpad" }),
    pill,
    h("span", { class: "spacer" }),
    newTab,
    restart,
    stop,
  )
  const banner = h("div", { class: "dash-error", role: "alert", hidden: true })

  const profile = h(
    "select",
    { "aria-label": "IPython profile" },
    PROFILES.map(([id, label]) => h("option", { value: id, text: label })),
  )
  const launchers = h(
    "div",
    { class: "scratch-launchers" },
    LAUNCHERS.map((item) =>
      h("button", {
        type: "button",
        "data-launch": item.id,
        text: item.label,
        onclick: () => launch(item.id),
      }),
    ),
  )
  const launcher = h(
    "section",
    { class: "scratch-launcher", "aria-label": "Launch" },
    h("label", { class: "dash-field" }, "Profile", profile),
    launchers,
  )

  const bar = h("progress", { max: "100" })
  const progressText = h("span", { class: "muted" })
  const progress = h(
    "div",
    { class: "scratch-progress", hidden: true, "aria-live": "polite" },
    bar,
    progressText,
  )

  const frame = h("iframe", {
    class: "scratch-frame",
    title: "JupyterLab",
    hidden: true,
    allow: "clipboard-read; clipboard-write; fullscreen",
  })
  const servers = h("section", { class: "scratch-servers", hidden: true })
  root.append(header, banner, launcher, progress, frame, servers)

  const showError = (error) => {
    banner.hidden = false
    banner.replaceChildren(h("span", { text: error.message }))
  }
  const setBusy = (value) => {
    busy = value
    const online = !!status?.host?.online
    for (const button of launchers.children) button.disabled = value || !online
    profile.disabled = value || !online
    // Stop, Restart and Open in new tab only make sense for a running server.
    const running = status?.server?.server === "running"
    stop.hidden = restart.hidden = newTab.hidden = !running
    stop.disabled = restart.disabled = value || !running
  }

  // ---- status ----
  async function refresh() {
    try {
      status = await api("/api/compute/status")
      banner.hidden = !status.error
      if (status.error) banner.replaceChildren(h("span", { text: status.error }))
    } catch (error) {
      status = null
      showError(error)
    }
    if (status?.lab) newTab.href = `${status.lab}lab`
    const { label, tone } = describeStatus(status)
    setText(pill, label)
    pill.className = `status status-${tone}`
    if (!busy) setBusy(false)
  }

  // ---- start / stop ----
  // POST /api/compute/server answers NDJSON: {progress:{message, percent}} lines, then the final
  // {done, ok, result|error}. Read it directly so the bar moves while the server spawns.
  async function ensureServer(profileId) {
    progress.hidden = false
    bar.removeAttribute("value")
    setText(progressText, "Starting your server…")
    const response = await fetch("/api/compute/server", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: profileId }),
    })
    if (response.status === 401) {
      location.assign("/auth/login?next=" + encodeURIComponent(location.pathname))
      throw new Error("Your session expired. Please sign in again.")
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(typeof data.detail === "string" ? data.detail : "Could not start the server.")
    }
    let final = null
    const parser = createNdjsonParser((line) => {
      if (line.progress) {
        if (typeof line.progress.percent === "number") bar.value = line.progress.percent
        if (line.progress.message) setText(progressText, line.progress.message)
      }
      if (line.done) final = line
    })
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parser.feed(value)
    }
    parser.end()
    progress.hidden = true
    if (!final?.ok)
      throw new Error(typeof final?.error === "string" ? final.error : "The server did not start.")
    return final.result
  }

  async function launch(id) {
    setBusy(true)
    banner.hidden = true
    try {
      await ensureServer(profile.value)
      open(launchUrl(status.lab, id, profile.value, pending ?? ""))
      pending = null
      await refresh()
    } catch (error) {
      progress.hidden = true
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  function open(url) {
    frame.hidden = false
    frame.src = url
    root.classList.add("scratch-open")
  }

  async function stopServer() {
    if (!confirm("Stop your server? Unsaved notebook changes are lost.")) return
    setBusy(true)
    try {
      await api("/api/compute/server", { method: "DELETE" })
      frame.hidden = true
      frame.removeAttribute("src")
      root.classList.remove("scratch-open")
      await refresh()
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  async function restartServer() {
    setBusy(true)
    try {
      const current = frame.getAttribute("src") || launchUrl(status.lab, "notebook", profile.value)
      await api("/api/compute/server", { method: "DELETE" })
      await ensureServer(profile.value)
      open(current)
      await refresh()
    } catch (error) {
      progress.hidden = true
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  // ---- owner: every member's server, with CPU/memory, open and stop ----
  async function loadServers() {
    let data
    try {
      data = await api("/api/compute/servers")
    } catch {
      servers.hidden = true
      return
    }
    const list = data.servers ?? []
    // Opening or stopping someone else's server needs owner access on the Worker and the host.
    const manage = !!(status?.owner_access && data.owner_access)
    const actions = (row) => {
      if (!manage || row.server !== "running" || row.login === login) return h("td", {})
      return h(
        "td",
        { class: "scratch-actions" },
        // On the lab origin, with a ticket for that one server: their lab code never sees this site.
        row.lab_url
          ? h("a", {
              class: "btn",
              href: row.lab_url,
              target: "_blank",
              rel: "noopener noreferrer",
              text: "Open lab",
            })
          : null,
        h("button", {
          type: "button",
          class: "danger",
          text: "Stop",
          onclick: async (event) => {
            if (!confirm(`Stop ${row.login}'s server? Their unsaved notebook changes are lost.`))
              return
            event.target.disabled = true
            try {
              await api(`/api/compute/servers/${encodeURIComponent(row.login)}`, {
                method: "DELETE",
              })
            } catch (error) {
              showError(error)
            }
            await loadServers()
          },
        }),
      )
    }
    servers.hidden = false
    servers.replaceChildren(
      ...present(
        h(
          "div",
          { class: "dash-section-head" },
          h("h2", { text: "Member servers" }),
          h("button", { type: "button", text: "Refresh", onclick: () => loadServers() }),
        ),
        manage
          ? null
          : h("p", {
              class: "muted",
              text: "Owner access is off, so members' servers can be listed but not opened or stopped.",
            }),
        list.length
          ? h(
              "table",
              { class: "scratch-table" },
              h(
                "thead",
                {},
                h(
                  "tr",
                  {},
                  ["Member", "Server", "CPU", "Memory", "Last activity", ""].map((text) =>
                    h("th", { text }),
                  ),
                ),
              ),
              h(
                "tbody",
                {},
                list.map((row) =>
                  h(
                    "tr",
                    {},
                    h("td", { class: "mono", text: row.login }),
                    h(
                      "td",
                      {},
                      h("span", {
                        class: `status status-${row.server === "running" ? "online" : "offline"}`,
                        text: row.server,
                      }),
                    ),
                    h("td", {
                      text: typeof row.cpu_percent === "number" ? `${row.cpu_percent}%` : "—",
                    }),
                    h("td", { text: formatMemory(row.memory_bytes, row.memory_max_bytes) }),
                    h("td", {
                      text: row.last_activity ? new Date(row.last_activity).toLocaleString() : "—",
                    }),
                    actions(row),
                  ),
                ),
              ),
            )
          : h("p", { class: "dash-empty", text: "No member servers." }),
      ),
    )
  }

  // ---- "Open notebook in Scratchpad": start the server, copy the notebook in, open it ----
  async function openFork(source) {
    setBusy(true)
    banner.hidden = true
    try {
      if (!status?.host?.online) throw new Error("The compute host is offline; try again later.")
      if (status?.server?.server !== "running") await ensureServer(profile.value)
      progress.hidden = false
      setText(progressText, `Copying ${source.split("/").pop()} into your Scratchpad…`)
      const data = await api("/api/compute/fork", {
        method: "POST",
        body: JSON.stringify({ source: { kind: "published", path: source } }),
      })
      progress.hidden = true
      // A reload opens the copy rather than forking again.
      const url = new URL(location.href)
      url.searchParams.delete("fork")
      url.searchParams.set("open", data.path)
      history.replaceState(history.state, "", url)
      open(launchUrl(status.lab, null, profile.value, data.path))
      await refresh()
    } catch (error) {
      progress.hidden = true
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  // ---- Hafezi GPT ----
  // The gpt-bridge lab extension posts {type: "hafezi-gpt:ask", context} from the iframe (its
  // Ctrl/⌘+J or a cell's "Ask Hafezi GPT"). The modal opens with that code attached, and code in
  // replies gets buttons that post it back into the lab; the member runs it themselves.
  const labOrigin = () => (status?.lab ? new URL(status.lab).origin : null)
  const toLab = (message) => {
    const origin = labOrigin()
    if (origin) frame.contentWindow?.postMessage(message, origin)
  }
  const sendToLab = (mode) => (code) => toLab(insertMessage(mode, code))
  const codeActions = [
    { label: "Insert below", run: sendToLab("below") },
    { label: "Replace cell", run: sendToLab("replace") },
  ]
  // The lab follows this site's light/dark mode: it asks once it has loaded, then gets each change.
  const theme = () => ({
    type: "hafezi-theme",
    theme: document.documentElement.getAttribute("saved-theme") === "dark" ? "dark" : "light",
  })
  new MutationObserver(() => toLab(theme())).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["saved-theme"],
  })
  window.addEventListener("message", (event) => {
    if (event.origin !== labOrigin() || event.source !== frame.contentWindow) return
    const data = event.data
    if (data?.type === "hafezi-theme:ready") toLab(theme())
    if (!data || data.type !== "hafezi-gpt:ask") return
    openGpt({ context: gptContext(data.context), codeActions }).catch(showError)
  })

  let pending = requestedPath(location.search)
  const forkSource = requestedFork(location.search)
  refresh().then(() => {
    if (forkSource) openFork(forkSource)
    // Re-open the lab after a reload when the server is already up (at the requested file).
    else if (status?.server?.server === "running") {
      open(pending ? launchUrl(status.lab, null, profile.value, pending) : `${status.lab}lab`)
      pending = null
    } else if (pending) showError(new Error(`Start your server to open ${pending}.`))
    if (isOwner && status?.host?.online) loadServers()
  })
  setInterval(() => {
    if (document.visibilityState === "visible" && !busy) refresh()
  }, POLL_MS)
}
