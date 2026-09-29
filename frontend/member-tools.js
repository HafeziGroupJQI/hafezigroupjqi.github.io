import { Calendar } from "@fullcalendar/core"
import dayGridPlugin from "@fullcalendar/daygrid"
import timeGridPlugin from "@fullcalendar/timegrid"
import listPlugin from "@fullcalendar/list"
import luxonPlugin from "@fullcalendar/luxon3"
import { DateTime } from "luxon"
import { mountAdmin } from "./admin/index.js"
import { installLauncher } from "./gpt/launcher.js"
import { h } from "./dashboard/dom.js"
import { mountDashboard } from "./dashboard/index.js"
import { legacyRedirect } from "./dashboard/router.js"
import { uploadsUrl } from "./uploads/model.js"

const zone = "America/New_York"
// Member pages are served at hafezigroupjqi.github.io by the members service worker, which also
// forwards these same-origin /api/* calls to the Worker with the member's bearer token. Signed out
// (no service worker answer), /api/session is simply not a user and the widgets stay unmounted.
const session = await fetch("/api/session", { cache: "no-store" })
  .then((response) => (response.ok ? response.json() : { user: null }))
  .catch(() => ({ user: null }))

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  })
  if (response.status === 401) {
    location.assign("/auth/login?next=" + encodeURIComponent(location.pathname + location.search))
    throw new Error("Your session expired. Please sign in again.")
  }
  const data = await response.json()
  if (!response.ok)
    throw new Error(
      typeof data.detail === "string" ? data.detail : "Check the event dates and required fields.",
    )
  return data
}

function element(tag, text, parent, attributes = {}) {
  const node = document.createElement(tag)
  if (text) node.textContent = text
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value))
  parent?.append(node)
  return node
}

function showError(parent, error) {
  const notice =
    parent.querySelector('[role="alert"]') ?? element("p", "", parent, { role: "alert" })
  notice.textContent = error.message
}

async function updateMenu() {
  const upcoming = document.querySelector("[data-upcoming-events]")
  const start = DateTime.now().setZone(zone)
  if (upcoming) {
    try {
      const events = await api(
        `/api/calendar/events?${new URLSearchParams({ start: start.toISO(), end: start.plus({ days: 14 }).toISO() })}`,
      )
      upcoming.textContent = events.length ? "Upcoming events" : "No events in the next two weeks."
      for (const event of events.slice(0, 3))
        element(
          "span",
          `${event.title} · ${DateTime.fromISO(event.start).setZone(zone).toFormat("ccc L/d, h:mma")}`,
          upcoming,
          { style: "display:block;margin-top:8px" },
        )
    } catch {
      upcoming.textContent = "Calendar unavailable"
    }
  }
}

function editor(calendar, clicked) {
  const dialog = element("dialog", "", document.body, {
    class: "member-editor",
    "aria-labelledby": "event-editor-title",
  })
  dialog.innerHTML = `<h2 id="event-editor-title">${clicked ? "Edit event" : "Add event"}</h2>
    <form>
      <label data-scope hidden>Apply changes to<select name="scope"><option value="series">Entire series</option><option value="occurrence">This occurrence</option></select></label>
      <label>Title<input name="title" required maxlength="200"></label>
      <label>Start<input name="start" type="datetime-local" required></label>
      <label>End<input name="end" type="datetime-local" required></label>
      <label>Timezone<input name="timezone" required value="America/New_York"></label>
      <label>Location<input name="location" maxlength="500"></label>
      <label>Description<textarea name="description" maxlength="10000" rows="3"></textarea></label>
      <label data-repeat>Repeat<select name="repeat"><option value="none">Does not repeat</option><option value="weekly">Weekly</option><option value="biweekly">Every two weeks</option><option value="monthly">Monthly</option></select></label>
      <label data-until>Repeat until (leave empty for no end)<input name="until" type="date"></label>
      <p data-series-note hidden>Changing the series schedule clears its individual exceptions.</p>
      <p role="alert"></p>
      <div class="editor-actions"><button type="submit">Save event</button><button type="button" data-delete hidden>Delete event</button><button type="button" data-cancel>Cancel</button></div>
    </form>`
  const form = dialog.querySelector("form")
  const field = (name) => form.elements.namedItem(name)
  let source, selected
  const fill = (data) => {
    for (const name of [
      "title",
      "start",
      "end",
      "timezone",
      "location",
      "description",
      "repeat",
      "until",
    ])
      field(name).value = data[name] ?? ""
  }
  const recurrenceUI = () => {
    const single = field("scope").value === "occurrence"
    dialog.querySelector("[data-repeat]").hidden = single
    dialog.querySelector("[data-until]").hidden = single || field("repeat").value === "none"
    dialog.querySelector("[data-series-note]").hidden =
      !source || single || source.repeat === "none"
  }
  field("repeat").addEventListener("change", recurrenceUI)
  field("scope").addEventListener("change", () => {
    fill(field("scope").value === "occurrence" ? selected : source)
    recurrenceUI()
  })
  dialog.querySelector("[data-cancel]").onclick = () => dialog.close()
  dialog.addEventListener("close", () => dialog.remove())
  const busy = (value) =>
    form.querySelectorAll("button").forEach((button) => (button.disabled = value))
  const savePath = () =>
    `/api/calendar/events${source ? "/" + source.id : ""}${source && field("scope").value === "occurrence" ? "?" + new URLSearchParams({ occurrence: clicked.extendedProps.occurrence }) : ""}`
  form.onsubmit = async (event) => {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(form))
    delete values.scope
    values.until = values.until || null
    values.version = source?.version ?? 0
    if (field("scope").value === "occurrence") {
      values.repeat = "none"
      values.until = null
    }
    busy(true)
    try {
      await api(savePath(), { method: source ? "PUT" : "POST", body: JSON.stringify(values) })
      dialog.close()
      calendar.refetchEvents()
      updateMenu()
    } catch (error) {
      showError(form, error)
    } finally {
      busy(false)
    }
  }
  dialog.querySelector("[data-delete]").onclick = async () => {
    if (
      !confirm(
        field("scope").value === "occurrence"
          ? "Delete this occurrence?"
          : "Delete this event and all its occurrences?",
      )
    )
      return
    busy(true)
    try {
      const url = new URL(savePath(), location.origin)
      url.searchParams.set("version", source.version)
      await api(url.pathname + url.search, { method: "DELETE" })
      dialog.close()
      calendar.refetchEvents()
      updateMenu()
    } catch (error) {
      showError(form, error)
    } finally {
      busy(false)
    }
  }
  dialog.showModal()
  if (clicked) {
    busy(true)
    api(`/api/calendar/events/${clicked.extendedProps.eventId}`)
      .then((data) => {
        source = data
        const occurrence = clicked.extendedProps.occurrence
        const duration = DateTime.fromISO(data.end).diff(DateTime.fromISO(data.start))
        selected = data.exceptions?.[occurrence] ?? {
          ...data,
          start: occurrence,
          end: DateTime.fromISO(occurrence).plus(duration).toISO({ includeOffset: false }),
        }
        fill(source)
        dialog.querySelector("[data-scope]").hidden = source.repeat === "none"
        dialog.querySelector("[data-delete]").hidden = false
        recurrenceUI()
        busy(false)
      })
      .catch((error) => showError(form, error))
  } else {
    const start = DateTime.now().setZone(zone).plus({ hours: 1 }).startOf("hour")
    fill({
      title: "",
      start: start.toFormat("yyyy-MM-dd'T'HH:mm"),
      end: start.plus({ hours: 1 }).toFormat("yyyy-MM-dd'T'HH:mm"),
      timezone: zone,
      repeat: "none",
    })
    recurrenceUI()
  }
}

function setupCalendar(root) {
  root.replaceChildren()
  const bar = element("div", "", root, { class: "tools-toolbar" })
  const add = element("button", "Add event", bar, { type: "button" })
  element("span", "All times Eastern · All lab members can manage events", bar)
  const notice = element("p", "", root, { role: "alert" })
  const canvas = element("div", "", root)
  const calendar = new Calendar(canvas, {
    plugins: [dayGridPlugin, timeGridPlugin, listPlugin, luxonPlugin],
    initialView: window.innerWidth < 600 ? "listMonth" : "dayGridMonth",
    timeZone: zone,
    headerToolbar: {
      left: "prev,next today",
      center: "title",
      right: "dayGridMonth,timeGridWeek,listMonth",
    },
    eventInteractive: true,
    height: "auto",
    slotMinTime: "07:00:00",
    slotMaxTime: "21:00:00",
    nowIndicator: true,
    events: async (range, success, failure) => {
      try {
        const data = await api(
          `/api/calendar/events?${new URLSearchParams({ start: range.startStr, end: range.endStr })}`,
        )
        notice.textContent = ""
        success(data)
      } catch (error) {
        notice.textContent = error.message
        failure(error)
      }
    },
    eventClick: ({ event }) => editor(calendar, event),
  })
  calendar.render()
  add.onclick = () => editor(calendar)
  if (location.hash === "#add-event") editor(calendar)
}

// ---- device-scoped instrument platform ----
// One tabbed dashboard at /devices (frontend/dashboard/). The old per-view pages (/device,
// /instrument, /experiments, /experiment-builder) still exist for bookmarks and forward to it.

// Member widgets call gated APIs; on a logged-out page that would 401 and bounce to login (which
// GitHub silently re-authorizes, appearing to "sign you back in" right after sign out). So only
// run them when signed in. Gated tool pages are unreachable logged-out anyway.
if (session.user) {
  updateMenu()
  const mount = (attr, setup) => {
    const node = document.querySelector(`[${attr}]`)
    if (node) setup(node)
  }
  mount("data-calendar", setupCalendar)
  mount("data-dashboard", (root) => mountDashboard(root, { api, session }))
  mount("data-admin", (root) => mountAdmin(root, { api, session }))
  // Hafezi GPT: the full app at /gpt, and "Ask Hafezi GPT" (Ctrl/⌘+J) on every other page.
  mount("data-hafezi-gpt", (root) =>
    import("./gpt/index.js")
      .then(({ mountGpt }) => mountGpt(root, { api, session }))
      .catch((error) => {
        console.error(error)
        root.replaceChildren(
          h("div", {
            class: "dash-error",
            role: "alert",
            text: "Hafezi GPT did not load. Reload the page to try again.",
          }),
        )
      }),
  )
  installLauncher({ api, session })
  // The Scratchpad (frontend/scratchpad/) loads only on its own page.
  mount("data-scratchpad", (root) =>
    import("./scratchpad/index.js")
      .then(({ mountScratchpad }) => mountScratchpad(root, { api, session }))
      .catch((error) => showError(root, error)),
  )
  // A notebook page's link to its raw file downloads it (?raw): opened plainly, a raw notebook
  // shows its rendered page (members service worker), which is this page.
  for (const link of document.querySelectorAll("p.wl-source a[href]")) {
    const url = new URL(link.href, location.href)
    url.searchParams.set("raw", "1")
    link.href = url.pathname + url.search
    link.setAttribute("download", "")
  }
  // The page's own tools above that line (frontend/notebook-page/): Open in Scratchpad for a file
  // of the private vault, and Download as for a Jupyter notebook.
  const sourceBar = document.querySelector("p.wl-source")
  if (sourceBar)
    import("./notebook-page/index.js")
      .then(({ mountNotebookPage }) => mountNotebookPage(sourceBar))
      .catch((error) => showError(sourceBar.parentElement, error))
  // A private page's file (a note's own, or a notebook's or Quarto page's source): replace it with
  // a new version or move it, as a draft on /uploads that becomes a pull request.
  const vaultFile =
    document.querySelector("[data-vault-source]")?.dataset.vaultSource ??
    document.querySelector("p.wl-source[data-source], .wl-notebook[data-source]")?.dataset.source
  const header = document.querySelector(".page-content__header")
  if (vaultFile && header)
    header.append(
      h(
        "p",
        { class: "page-file-tools" },
        h("a", { href: uploadsUrl("replace", vaultFile), text: "Replace this file…" }),
        h("a", { href: uploadsUrl("rename", vaultFile), text: "Rename or move…" }),
      ),
    )
  // A member's own settings: their People page, photo and Wolfram Engine license.
  mount("data-settings", (root) =>
    import("./settings/index.js")
      .then(({ mountSettings }) => mountSettings(root, { api, session }))
      .catch((error) => showError(root, error)),
  )
  // Uploads to the private vault: drafts that become pull requests merged hourly (src/uploads/).
  mount("data-uploads", (root) =>
    import("./uploads/index.js")
      .then(({ mountUploads }) => mountUploads(root, { api, session }))
      .catch((error) => showError(root, error)),
  )
  // Wolfram notebook pages (tools/notebooks/, frontend/wolfram-notebook/): Run / Edit / Copy /
  // Open in Scratchpad on every code cell.
  mount("data-wolfram-notebook", (root) =>
    import("./wolfram-notebook/index.js")
      .then(({ mountWolframNotebook }) => mountWolframNotebook(root, { api, session }))
      .catch((error) => showError(root, error)),
  )
  for (const attr of [
    "data-device",
    "data-instrument",
    "data-experiment-builder",
    "data-experiments",
  ])
    mount(attr, () => location.replace(legacyRedirect(location.pathname, location.search)))
}
