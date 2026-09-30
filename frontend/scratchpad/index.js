// The /scratchpad page: live Jupyter/IPython/Quarto/Wolfram on the lab's compute host. The lab
// itself is an iframe on its own origin (the Worker's, /lab/<ticket>/jupyter/user/<login>/lab), so
// code running in it can never reach this site or the members token; the two talk only through
// postMessage with explicit origins. This page shows host status, starts and stops the member's
// server, and launches consoles and documents into the iframe: by message to a lab already running
// there (it says when it's ready and acks each request), else by loading the lab with the request
// in its URL.
// member-tools.js lazy-loads mountScratchpad() with its api() (JSON + 401 → login) and the session.

import { h, present, setText } from "../dashboard/dom.js"
import { openGpt, setLauncherHidden } from "../gpt/launcher.js"
import { gptContext, insertMessage } from "./gpt.js"
import {
  LAUNCHERS,
  PROFILES,
  USER_PROFILE,
  createNdjsonParser,
  describeStatus,
  formatMemory,
  keepProfile,
  launchMessage,
  launchPlan,
  launchRef,
  launchUrl,
  ownProfiles,
  pendingStatus,
  requestedFork,
  requestedPath,
} from "./launch.js"

const POLL_MS = 15_000

export function mountScratchpad(root, { api, session }) {
  const login = session.user.login.toLowerCase()
  const isOwner = session.user.role === "owner"
  let status = null
  let busy = false
  // Whether the lab now loaded in the frame said it takes launches by message (launch.js).
  let labReady = false

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

  // Built-in profiles, then the member's own (~/profiles, made from notebooks in the lab).
  const ownGroup = h("optgroup", { label: "Your profiles", hidden: true })
  const profile = h(
    "select",
    { "aria-label": "IPython profile" },
    h(
      "optgroup",
      { label: "Built-in" },
      PROFILES.map(([id, label]) => h("option", { value: id, text: label })),
    ),
    ownGroup,
  )
  const profileNote = h("span", { class: "muted", role: "status", hidden: true })
  const noteProfile = (text) => {
    setText(profileNote, text)
    profileNote.hidden = !text
  }
  // Asked of the host when it comes online, whenever the list is opened and before a launch on an
  // own profile, so a profile just saved in the lab shows up and one deleted there is let go.
  let profilesLoading = null
  function loadProfiles() {
    if (profilesLoading || !status?.host?.online) return profilesLoading
    profilesLoading = api("/api/compute/profiles")
      .then((listing) => {
        const chosen = profile.value
        const chosenLabel = profile.selectedOptions[0]?.text ?? chosen
        const own = ownProfiles(listing)
        ownGroup.replaceChildren(
          ...own.map(([id, label]) => h("option", { value: id, text: label })),
        )
        ownGroup.hidden = !own.length
        const kept = keepProfile(chosen, own, chosenLabel)
        profile.value = kept.profile
        if (kept.note) noteProfile(kept.note)
      })
      .catch(() => {}) // an older host without the op: the built-ins stay
      .finally(() => (profilesLoading = null))
    return profilesLoading
  }
  profile.addEventListener("focus", () => void loadProfiles())
  profile.addEventListener("change", () => noteProfile(""))
  // The profile to start on: an own one is looked up again first, since starting on one deleted in
  // the lab would ask for a kernel that no longer exists.
  async function chosenProfile() {
    if (USER_PROFILE.test(profile.value)) await loadProfiles()
    return profile.value
  }
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
    profileNote,
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
  const showStatus = ({ label, tone }) => {
    setText(pill, label)
    pill.className = `status status-${tone}`
  }
  // The server is starting ("spawn") or stopping ("stop") at this page's request: the pill says so
  // until the status is read again, which the last one can't know.
  const showPending = (action) => showStatus(describeStatus(pendingStatus(status, action)))
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
    if (status?.host?.online && ownGroup.hidden && !ownGroup.dataset.asked) {
      ownGroup.dataset.asked = "1"
      void loadProfiles()
    }
    showStatus(describeStatus(status))
    if (!busy) setBusy(false)
  }

  // ---- start / stop ----
  // POST /api/compute/server answers NDJSON: {progress:{message, percent}} lines, then the final
  // {done, ok, result|error}. Read it directly so the bar moves while the server spawns.
  async function ensureServer(profileId) {
    showPending("spawn")
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
    noteProfile("")
    try {
      const chosen = await chosenProfile()
      // A lab that is up in the frame opens it where it is, with no reload.
      if (await askLab(launchMessage(id, chosen, pending ?? "", nextRef()))) {
        pending = null
        await refresh()
        return
      }
      await ensureServer(chosen)
      open(launchUrl(status.lab, id, chosen, pending ?? ""))
      pending = null
      await refresh()
      refreshServers()
    } catch (error) {
      progress.hidden = true
      // Where the server stands after a failed start: the pill said starting.
      await refresh()
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  // The site's GPT button hides while the lab in the frame has its own panel (it says so once it
  // has loaded), so it comes back with each new lab and when the lab closes.
  function open(url) {
    labReady = false
    frame.hidden = false
    frame.src = url
    root.classList.add("scratch-open")
    setLauncherHidden(false)
  }

  function close() {
    labReady = false
    frame.hidden = true
    frame.removeAttribute("src")
    root.classList.remove("scratch-open")
    setLauncherHidden(false)
  }

  // ---- the lab in the frame, asked by message (launch.js) ----
  // Ready once the lab now loaded in the frame says so; a load of anything else, or a lab that
  // doesn't ack in time, makes the page load the lab at the request's URL instead.
  let refs = 0
  const nextRef = () => launchRef(++refs)
  const acks = new Map()
  frame.addEventListener("load", () => (labReady = false))
  function sendToLabAndWait(message, ms = 3000) {
    return new Promise((resolve) => {
      const done = (ok) => {
        clearTimeout(timer)
        acks.delete(message.ref)
        resolve(ok)
      }
      const timer = setTimeout(() => done(false), ms)
      acks.set(message.ref, () => done(true))
      toLab(message)
    })
  }
  // Whether the running lab took the request (false: navigate instead).
  const askLab = async (message) =>
    !!message &&
    launchPlan({ labReady, running: status?.server?.server === "running" }) === "message" &&
    (await sendToLabAndWait(message))

  async function stopServer() {
    if (!confirm("Stop your server? Unsaved notebook changes are lost.")) return
    setBusy(true)
    // The host takes a few seconds to stop the lab: the pill says so until the next status.
    showPending("stop")
    try {
      await api("/api/compute/server", { method: "DELETE" })
      close()
      await refresh()
      refreshServers()
    } catch (error) {
      showStatus(describeStatus(status))
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  async function restartServer() {
    setBusy(true)
    try {
      const chosen = await chosenProfile()
      const current = frame.getAttribute("src") || launchUrl(status.lab, "notebook", chosen)
      showPending("stop")
      await api("/api/compute/server", { method: "DELETE" })
      await ensureServer(chosen)
      open(current)
      await refresh()
      refreshServers()
    } catch (error) {
      progress.hidden = true
      await refresh()
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  // ---- owner: every member's server, with CPU/memory, open and stop ----
  // The table lists the owner's own server too: it follows their Start, Restart and Stop.
  function refreshServers() {
    if (isOwner && status?.host?.online) loadServers()
  }

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
            if (
              !confirm(
                `Stop the server of ${row.login}? Unsaved changes in its open notebooks will be lost.`,
              )
            )
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
      if (status?.server?.server !== "running") await ensureServer(await chosenProfile())
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
      if (!(await askLab(launchMessage(null, profile.value, data.path, nextRef()))))
        open(launchUrl(status.lab, null, profile.value, data.path))
      await refresh()
      refreshServers()
    } catch (error) {
      progress.hidden = true
      await refresh()
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
    // The lab can open launchers and files by message from now until the frame loads again.
    if (data?.type === "hafezi-lab:ready" && data.launch >= 1) labReady = true
    if (data?.type === "hafezi-launch:ack") acks.get(data.ref)?.()
    // The lab has Hafezi GPT in its own panel (its Ctrl/⌘+J opens it): no site button over it.
    // Ctrl/⌘+J outside the frame still opens the site's modal.
    if (data?.type === "hafezi-gpt:panel") setLauncherHidden(true)
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
    refreshServers()
  })
  setInterval(() => {
    if (document.visibilityState === "visible" && !busy) refresh()
  }, POLL_MS)
}
