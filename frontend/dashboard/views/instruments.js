// Instruments tab: one device's instruments as chips; the focused one's meta, ports, live plot
// (history backfill + SSE) and latest values.
import { h, patchList, pill, present, setText } from "../dom.js"
import { instrumentLiveness } from "../liveness.js"
import { livePlot } from "../plot.js"
import { devicePicker, link, needDevice } from "./common.js"
import { metricsFor } from "./device.js"

export function instrumentsModel(state, route) {
  const code = route.code
  const liveness = state.devices.get(code)?.liveness ?? "pending"
  const list = [...(state.instruments.get(code)?.values() ?? [])]
  const selected = list.find((i) => i.local_id === route.id) ?? list[0] ?? null
  const chips = list.map((i) => ({
    id: i.local_id,
    title: i.title || i.local_id,
    status: instrumentLiveness(i, liveness),
    selected: i === selected,
  }))
  if (!selected) return { code, chips, selected: null, loaded: state.instruments.has(code) }
  const series = []
  const prefix = `${code}|${selected.local_id}|`
  for (const [key, points] of state.series)
    if (key.startsWith(prefix))
      series.push({
        name: key.slice(prefix.length),
        units: state.latest.get(key)?.units ?? null,
        points,
      })
  series.sort((a, b) => a.name.localeCompare(b.name))
  return {
    code,
    chips,
    loaded: true,
    selected: {
      id: selected.local_id,
      title: selected.title || selected.local_id,
      status: instrumentLiveness(selected, liveness),
      meta: [
        selected.model,
        selected.driver,
        selected.address_kind !== "null" && selected.address_kind,
      ]
        .filter(Boolean)
        .join(" · "),
      capabilities: selected.capabilities ?? [],
      ports: selected.ports ?? [],
      metrics: metricsFor(state, code, selected),
      series,
      hasHistory: Array.isArray(selected.history),
    },
  }
}

export function mountInstruments(panel, ctx, route) {
  if (!route.code) {
    const need = needDevice(ctx, route)
    panel.append(need.element)
    return { update: need.fill }
  }
  const code = route.code
  const picker = devicePicker(ctx, route)
  const chips = h("nav", { class: "inst-chips", "aria-label": "Instruments" })
  const detail = h("div", { class: "inst-detail" })
  panel.append(
    h(
      "div",
      { class: "dash-section-head" },
      h("h2", { class: "mono", text: code }),
      h("span", { class: "spacer" }),
      picker.element,
    ),
    h("div", { class: "inst-split" }, chips, detail),
  )
  let current = null
  let plot = null
  let lastPlot = 0
  const requested = new Set()

  function update(state) {
    picker.fill(state)
    const m = instrumentsModel(state, route)
    patchList(
      chips,
      m.chips,
      (c) => c.id,
      (c) => link({ tab: "instruments", code, id: c.id }, "", { class: "chip" }),
      (node, c) => {
        node.replaceChildren(h("span", { text: c.title }), pill(c.status))
        node.setAttribute("aria-current", c.selected ? "true" : "false")
      },
    )
    if (!m.selected) {
      if (m.loaded)
        detail.replaceChildren(
          h("p", { class: "muted", text: "This device has declared no instruments yet." }),
        )
      return
    }
    const s = m.selected
    if (!s.hasHistory && !requested.has(s.id)) {
      requested.add(s.id)
      ctx.loadInstrument(code, s.id)
    }
    if (current !== s.id) {
      current = s.id
      detail.replaceChildren(
        ...present(
          h(
            "header",
            { class: "dash-section-head" },
            h("h3", { "data-t": "" }),
            h("span", { "data-p": "" }),
            h("span", { class: "spacer" }),
            h("button", {
              type: "button",
              text: "Poll",
              onclick: (e) => ctx.command(code, "poll", { local_id: s.id }, e.currentTarget),
            }),
          ),
          h("p", { class: "muted", "data-meta": "" }),
          s.ports.length
            ? h(
                "div",
                { class: "port-map" },
                s.ports.map((p) =>
                  h(
                    "span",
                    { class: `port port-${p.direction}` },
                    h("strong", { text: p.label || p.id }),
                    h("span", { text: ` ${p.direction}` }),
                  ),
                ),
              )
            : null,
          h("div", { class: "latest-grid", "data-latest": "" }),
          h("div", { "data-plot": "" }),
        ),
      )
      plot = livePlot(detail.querySelector("[data-plot]"))
      lastPlot = 0
    }
    setText(detail.querySelector("[data-t]"), s.title)
    const p = detail.querySelector("[data-p]")
    if (p.textContent !== s.status) p.replaceChildren(pill(s.status))
    setText(
      detail.querySelector("[data-meta]"),
      [s.meta, s.capabilities.length && `capabilities: ${s.capabilities.join(", ")}`]
        .filter(Boolean)
        .join(" · "),
    )
    patchList(
      detail.querySelector("[data-latest]"),
      s.metrics,
      (x) => x.metric,
      () =>
        h(
          "div",
          { class: "latest-tile" },
          h("span", { class: "metric-name" }),
          h("strong", { class: "metric-value" }),
        ),
      (node, x) => {
        node.dataset.metric = x.metric
        setText(node.firstChild, x.metric)
        setText(node.lastChild, x.text)
      },
    )
    if (state.now - lastPlot >= 900 || lastPlot === 0) {
      lastPlot = state.now || 1
      plot.set(s.series)
      plot.render()
    }
  }
  return { update, streamCode: () => code }
}
