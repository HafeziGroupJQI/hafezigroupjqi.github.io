import { Calendar } from "@fullcalendar/core"
import dayGridPlugin from "@fullcalendar/daygrid"
import timeGridPlugin from "@fullcalendar/timegrid"
import listPlugin from "@fullcalendar/list"
import luxonPlugin from "@fullcalendar/luxon3"
import { DateTime } from "luxon"

const zone = "America/New_York"
const session = await fetch("/api/session", { cache: "no-store" }).then((response) =>
  response.json(),
)
if (!session.user) location.replace("/auth/login?next=" + encodeURIComponent(location.pathname))

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": session.csrf,
      ...options.headers,
    },
  })
  if (response.status === 401) {
    location.assign("/auth/login?next=" + encodeURIComponent(location.pathname))
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

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  )

const fail = (container, message) => {
  container.innerHTML = `<p class="muted">${escape(message)}</p>`
}

// The instrument service is often simply off; that is a normal state to render, not an error.
async function setupInstruments(container) {
  let state
  try {
    state = await api("/api/c2/status")
  } catch {
    return fail(container, "Could not reach the member site API.")
  }
  if (state.state !== "connected")
    return fail(
      container,
      state.state === "not_configured"
        ? "The instrument service is not configured yet."
        : "The instrument service is unavailable. The lab machine may be switched off.",
    )

  let instruments
  try {
    instruments = await api("/api/c2/instruments")
  } catch (error) {
    return fail(container, error.message)
  }
  if (!instruments.length) return fail(container, "No instruments are registered.")

  container.innerHTML = `
    <table class="instrument-table">
      <thead><tr><th>Instrument</th><th>Status</th><th>Latest</th><th></th></tr></thead>
      <tbody>${instruments
        .map((instrument) => {
          const latest = Object.entries(instrument.latest ?? {})
            .map(([metric, value]) => `${escape(metric)} ${escape(Array.isArray(value) ? value[0] : value)}`)
            .join(", ")
          return `<tr data-id="${escape(instrument.id)}">
            <td>${escape(instrument.title || instrument.id)}</td>
            <td class="status status-${escape(instrument.status)}">${escape(instrument.status)}</td>
            <td class="latest">${latest || "&mdash;"}</td>
            <td>${instrument.controllable ? '<button type="button" data-poll>Poll now</button>' : ""}</td>
          </tr>`
        })
        .join("")}</tbody>
    </table>`

  container.querySelectorAll("[data-poll]").forEach((button) => {
    button.onclick = async () => {
      const row = button.closest("tr")
      button.disabled = true
      button.textContent = "Polling…"
      try {
        const result = await api(`/api/c2/instruments/${encodeURIComponent(row.dataset.id)}/poll`, {
          method: "POST",
        })
        row.querySelector(".latest").textContent =
          Object.entries(result.metrics ?? {})
            .map(([metric, value]) => `${metric} ${value}`)
            .join(", ") || "\u2014"
        row.querySelector(".status").textContent = result.status ?? "unknown"
      } catch (error) {
        row.querySelector(".latest").textContent = error.message
      } finally {
        button.disabled = false
        button.textContent = "Poll now"
      }
    }
  })
}

async function setupRuns(container) {
  let runs
  try {
    runs = await api("/api/c2/runs")
  } catch (error) {
    return fail(container, error.message)
  }
  if (!runs.length) return fail(container, "No experiment runs recorded yet.")
  container.innerHTML = `
    <table class="run-table">
      <thead><tr><th>Run</th><th>Procedure</th><th>Status</th><th>Operator</th><th>Started</th></tr></thead>
      <tbody>${runs
        .map(
          (run) => `<tr>
            <td><code>${escape(run.run_id)}</code></td>
            <td>${escape(run.procedure)}</td>
            <td class="status status-${escape(run.status)}">${escape(run.status)}</td>
            <td>${escape(run.operator || "\u2014")}</td>
            <td>${escape(new Date(run.started + "Z").toLocaleString("en-US", { timeZone: "America/New_York" }))}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table>`
}

updateMenu()
const calendar = document.querySelector("[data-calendar]")
if (calendar) setupCalendar(calendar)
const instruments = document.querySelector("[data-instruments]")
if (instruments) setupInstruments(instruments)
const runs = document.querySelector("[data-runs]")
if (runs) setupRuns(runs)
