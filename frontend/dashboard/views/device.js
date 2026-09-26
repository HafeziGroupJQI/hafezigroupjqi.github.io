// Device tab: one lab PC — facts, instrument cards with live values and Poll, the live log.
import { h, patchList, pill, setText } from "../dom.js"
import { fmtValue, relTime } from "../format.js"
import { ageLabel, ageMs, instrumentLiveness } from "../liveness.js"
import { seriesKey } from "../store.js"
import { devicePicker, link, needDevice } from "./common.js"

export const STREAM_LABELS = {
  open: "live",
  connecting: "connecting…",
  reconnecting: "reconnecting…",
  paused: "paused",
  closed: "closed",
}

export function metricsFor(state, code, inst) {
  const names = new Set(Object.keys(inst.latest ?? {}))
  const prefix = `${code}|${inst.local_id}|`
  for (const key of state.latest.keys()) if (key.startsWith(prefix)) names.add(key.slice(prefix.length))
  return [...names].sort().map((metric) => {
    const r = state.latest.get(seriesKey(code, inst.local_id, metric))
    return { metric, value: r?.value ?? null, units: r?.units ?? null, text: fmtValue(r?.value, r?.units) }
  })
}

export function deviceModel(state, route) {
  const code = route.code
  const row = state.details.get(code) ?? state.devices.get(code)
  if (!row) return { code, missing: true }
  const liveness = (state.devices.get(code) ?? row).liveness
  const facts = [
    ["Hostname", row.hostname || "—"],
    ["Platform", row.platform || "—"],
    ["Agent", row.agent_version || "—"],
    ["Enrolled", row.enrolled ? (row.enrolled_at ? new Date(row.enrolled_at).toLocaleString("en-US") : "yes") : "not yet"],
    ["Last heartbeat", liveness === "pending" ? "never" : ageLabel(ageMs(state.devices.get(code) ?? row, state.now))],
  ]
  const instruments = [...(state.instruments.get(code)?.values() ?? [])].map((inst) => ({
    id: inst.local_id,
    title: inst.title || inst.local_id,
    driver: inst.driver || "",
    ports: inst.ports?.length ?? 0,
    status: instrumentLiveness(inst, liveness),
    metrics: metricsFor(state, code, inst),
  }))
  return {
    code,
    liveness,
    facts,
    instruments,
    instrumentsLoaded: state.instruments.has(code),
    logs: state.logs.get(code) ?? [],
    stream: STREAM_LABELS[state.streams.get(code)] ?? "offline",
  }
}

export function mountDevice(panel, ctx, route) {
  if (!route.code) {
    const need = needDevice(ctx, route)
    panel.append(need.element)
    return { update: need.fill }
  }
  const code = route.code
  const picker = devicePicker(ctx, route)
  const head = h("div", { class: "dash-section-head" },
    h("h2", { class: "mono", text: code }), h("span", { "data-pill": "" }),
    h("span", { class: "sse-badge", "data-sse": "" }),
    h("span", { class: "spacer" }), picker.element,
    link({ tab: "builder", code }, "Build an experiment", { class: "btn" }))
  const kv = h("dl", { class: "kv" })
  const insts = h("div", { class: "inst-cards" })
  let paused = false
  const pause = h("button", { type: "button", text: "Pause", onclick: () => { paused = !paused; pause.textContent = paused ? "Resume" : "Pause" } })
  const logPane = h("div", { class: "log-pane", tabindex: "0", "aria-label": "Live log" })
  panel.append(
    head,
    h("section", { class: "dash-grid-2" },
      h("div", {}, h("h3", { text: "Facts" }), kv),
      h("div", {}, h("h3", { text: "Instruments" }), insts)),
    h("section", {}, h("div", { class: "dash-section-head" }, h("h3", { text: "Live log" }), h("span", { class: "spacer" }), pause,
      h("button", { type: "button", text: "Clear", onclick: () => ctx.store.dispatch({ type: "clearLogs", code }) })), logPane),
  )

  let lastLogCount = -1
  let lastLogLast = null
  function update(state) {
    picker.fill(state)
    const m = deviceModel(state, route)
    if (m.missing) {
      if (state.devicesLoaded) kv.replaceChildren(h("p", { class: "muted", text: `No device called ${code}.` }))
      return
    }
    const pillHost = head.querySelector("[data-pill]")
    if (pillHost.textContent !== m.liveness) pillHost.replaceChildren(pill(m.liveness))
    const sse = head.querySelector("[data-sse]")
    setText(sse, m.stream)
    sse.dataset.state = m.stream
    patchList(kv, m.facts, ([k]) => k, () => h("div", {}, h("dt"), h("dd")), (node, [k, v]) => {
      setText(node.firstChild, k)
      setText(node.lastChild, v)
    })
    if (m.instrumentsLoaded && !m.instruments.length)
      insts.replaceChildren(h("p", { class: "muted", text: "This device has declared no instruments yet." }))
    else
      patchList(insts, m.instruments, (i) => i.id,
        (i) => h("article", { class: "inst-card" },
          h("header", {}, link({ tab: "instruments", code, id: i.id }, "", { "data-title": "" }), h("span", { "data-pill": "" })),
          h("p", { class: "muted", "data-sub": "" }),
          h("div", { class: "latest-metrics", "data-latest": "" }),
          h("button", { type: "button", text: "Poll", onclick: (e) => ctx.command(code, "poll", { local_id: i.id }, e.currentTarget) })),
        (node, i) => {
          setText(node.querySelector("[data-title]"), i.title)
          const p = node.querySelector("[data-pill]")
          if (p.textContent !== i.status) p.replaceChildren(pill(i.status))
          setText(node.querySelector("[data-sub]"), [i.driver, i.ports && `${i.ports} ports`].filter(Boolean).join(" · "))
          patchList(node.querySelector("[data-latest]"), i.metrics, (x) => x.metric,
            () => h("span", {}, h("span", { class: "metric-name" }), h("span", { class: "metric-value" })),
            (span, x) => {
              span.dataset.metric = x.metric
              setText(span.firstChild, x.metric + " ")
              setText(span.lastChild, x.text)
            })
        })
    if (!paused && (m.logs.length !== lastLogCount || m.logs.at(-1) !== lastLogLast)) {
      lastLogCount = m.logs.length
      lastLogLast = m.logs.at(-1)
      const stick = logPane.scrollTop + logPane.clientHeight >= logPane.scrollHeight - 8
      patchList(logPane, m.logs, (l) => `${l.ts_ns}|${l.message}`,
        (l) => h("div", { class: `log-line log-${l.level}`, title: relTime(l.ts_ns, Date.now()) },
          `[${l.level}] ${l.local_id ? l.local_id + ": " : ""}${l.message}`))
      if (!m.logs.length) logPane.replaceChildren(h("p", { class: "muted", text: "No log lines yet." }))
      if (stick) logPane.scrollTop = logPane.scrollHeight
    }
  }
  return { update, streamCode: () => code }
}
