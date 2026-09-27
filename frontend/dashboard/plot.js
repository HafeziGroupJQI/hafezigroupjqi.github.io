// The live line plot, moved from member-tools.js (dataviz rules: the validated --viz-* palette in
// a fixed order, a legend for 2+ series, direct labels only when ≤ 4, small multiples past 8, a
// numeric table always available). Fixes over the original: small multiples keep each series'
// own colour; > 8 series are grouped by units (capped at 16 with "N more"); legend items toggle
// series; a 1 min / 5 min / all window; units on the y-axis; a nearest-x hover readout.
// planPlot() is pure (tested); livePlot() is the thin DOM layer.

import { h } from "./dom.js"
import { fmtValue } from "./format.js"

export const WINDOWS = { "1m": 60_000, "5m": 300_000, all: Infinity }
const MAX_SERIES = 16

/**
 * series: [{ name, units, points: [{x, y}] }] in a stable order. Returns the panels to draw:
 * one combined chart for ≤ 8 visible series, otherwise one small multiple per units group.
 */
export function planPlot(series, { window = "all", now = Date.now(), hidden = new Set() } = {}) {
  const span = WINDOWS[window] ?? Infinity
  const colored = series.map((s, i) => ({ ...s, color: (i % 8) + 1 }))
  const shown = colored.slice(0, MAX_SERIES)
  const overflow = colored.length - shown.length
  const visible = shown
    .filter((s) => !hidden.has(s.name))
    .map((s) => ({
      ...s,
      points: s.points.filter((p) => Number.isFinite(p.y) && now - p.x <= span),
    }))
  // One shared chart only when the series share units and fit the palette; otherwise small
  // multiples per units group (never two scales on one axis).
  const unitSet = new Set(visible.map((s) => s.units || ""))
  let panels
  if (visible.length <= 8 && unitSet.size <= 1)
    panels = [{ title: null, units: commonUnits(visible), series: visible }]
  else {
    const groups = new Map()
    for (const s of visible) {
      const key = s.units || ""
      groups.set(key, [...(groups.get(key) ?? []), s])
    }
    panels = [...groups].map(([units, list]) => ({
      title: units || "no units",
      units: units || null,
      series: list,
    }))
  }
  return {
    legend: shown.map((s) => ({ name: s.name, color: s.color, hidden: hidden.has(s.name) })),
    panels,
    overflow,
    directLabels: panels.every((p) => p.series.length <= 4),
  }
}

const commonUnits = (list) => {
  const units = [...new Set(list.map((s) => s.units).filter(Boolean))]
  return units.length === 1 ? units[0] : null
}

const svgNs = "http://www.w3.org/2000/svg"

export function livePlot(host, { mini = false } = {}) {
  const wrap = h("div", { class: "live-plot" })
  host.append(wrap)
  let series = []
  let showTable = false
  let window = "all"
  const hidden = new Set()

  function chart(panel, directLabels) {
    const W = 640
    const H = mini ? 140 : 300
    const pad = { l: 60, r: 14, t: 12, b: 26 }
    const points = panel.series.flatMap((s) => s.points)
    const box = h("div", { class: "plot-panel" })
    if (panel.title) box.append(h("p", { class: "plot-panel-title", text: panel.title }))
    if (!points.length) {
      box.append(h("p", { class: "muted", text: "No points in this window." }))
      return box
    }
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    const xMin = Math.min(...xs)
    const xMax = Math.max(...xs)
    const yMin = Math.min(...ys)
    const yMax = Math.max(...ys)
    const spanX = xMax - xMin || 1
    const spanY = yMax - yMin || 1
    const sx = (x) => pad.l + ((x - xMin) / spanX) * (W - pad.l - pad.r)
    const sy = (y) => H - pad.b - ((y - yMin) / spanY) * (H - pad.t - pad.b)
    const svg = document.createElementNS(svgNs, "svg")
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`)
    svg.setAttribute("class", "plot-svg")
    svg.setAttribute("role", "img")
    svg.setAttribute("aria-label", panel.series.map((s) => s.name).join(", "))
    const el = (tag, attrs, text) => {
      const node = document.createElementNS(svgNs, tag)
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
      if (text != null) node.textContent = text
      svg.appendChild(node)
      return node
    }
    el("line", { x1: pad.l, y1: H - pad.b, x2: W - pad.r, y2: H - pad.b, class: "plot-axis" })
    el("line", { x1: pad.l, y1: pad.t, x2: pad.l, y2: H - pad.b, class: "plot-axis" })
    const time = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour12: false })
    el("text", { x: pad.l, y: H - 6, class: "plot-tick" }, time(xMin))
    el("text", { x: W - pad.r, y: H - 6, class: "plot-tick", "text-anchor": "end" }, time(xMax))
    el(
      "text",
      { x: pad.l - 6, y: pad.t + 8, class: "plot-tick", "text-anchor": "end" },
      fmtValue(yMax),
    )
    el(
      "text",
      { x: pad.l - 6, y: H - pad.b, class: "plot-tick", "text-anchor": "end" },
      fmtValue(yMin),
    )
    if (panel.units)
      el(
        "text",
        {
          x: 12,
          y: H / 2,
          class: "plot-tick",
          transform: `rotate(-90 12 ${H / 2})`,
          "text-anchor": "middle",
        },
        panel.units,
      )
    for (const s of panel.series) {
      if (!s.points.length) continue
      const color = `var(--viz-${s.color})`
      const d = s.points
        .map((p, j) => `${j ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
        .join(" ")
      el("path", { d, fill: "none", "stroke-width": "2", style: `stroke:${color}` })
      const last = s.points[s.points.length - 1]
      el("circle", { cx: sx(last.x), cy: sy(last.y), r: "3.5", style: `fill:${color}` })
      if (directLabels)
        el(
          "text",
          { x: sx(last.x) - 6, y: sy(last.y) - 6, class: "plot-label", "text-anchor": "end" },
          `${s.name} ${fmtValue(last.y)}`,
        )
    }
    // Hover readout: nearest x across the panel's series.
    const cursor = el("line", {
      x1: 0,
      y1: pad.t,
      x2: 0,
      y2: H - pad.b,
      class: "plot-cursor",
      visibility: "hidden",
    })
    const readout = h("p", { class: "plot-readout muted", "aria-live": "off" }, " ")
    svg.addEventListener("pointermove", (event) => {
      const rect = svg.getBoundingClientRect()
      const x =
        xMin +
        ((((event.clientX - rect.left) / rect.width) * W - pad.l) / (W - pad.l - pad.r)) * spanX
      const parts = []
      let nearestX = null
      for (const s of panel.series) {
        let best = null
        for (const p of s.points) if (!best || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p
        if (best) {
          nearestX ??= best.x
          parts.push(`${s.name} ${fmtValue(best.y, s.units)}`)
        }
      }
      if (nearestX == null) return
      cursor.setAttribute("x1", sx(nearestX))
      cursor.setAttribute("x2", sx(nearestX))
      cursor.setAttribute("visibility", "visible")
      readout.textContent = `${time(nearestX)} · ${parts.join(" · ")}`
    })
    svg.addEventListener("pointerleave", () => cursor.setAttribute("visibility", "hidden"))
    box.append(svg, readout)
    return box
  }

  function table() {
    const t = h("table", { class: "plot-table" })
    const head = h(
      "tr",
      {},
      h("th", { text: "time" }),
      series.map((s) => h("th", { text: s.name })),
    )
    t.append(h("thead", {}, head))
    const body = h("tbody")
    const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))]
      .sort((a, b) => a - b)
      .slice(-12)
    for (const x of times)
      body.append(
        h(
          "tr",
          {},
          h("td", { text: new Date(x).toLocaleTimeString("en-US", { hour12: false }) }),
          series.map((s) => h("td", { text: fmtValue(s.points.find((p) => p.x === x)?.y) })),
        ),
      )
    t.append(body)
    return t
  }

  function render() {
    wrap.replaceChildren()
    if (!series.some((s) => s.points.length)) {
      wrap.append(h("p", { class: "muted", text: "Waiting for the first point…" }))
      return
    }
    const plan = planPlot(series, { window, hidden })
    const bar = h("div", { class: "plot-bar" })
    bar.append(
      h(
        "button",
        { type: "button", onclick: () => ((showTable = !showTable), render()) },
        showTable ? "Show chart" : "Show table",
      ),
    )
    const windows = h("div", { class: "seg", role: "radiogroup", "aria-label": "Time window" })
    for (const key of Object.keys(WINDOWS))
      windows.append(
        h(
          "button",
          {
            type: "button",
            role: "radio",
            "aria-checked": String(window === key),
            onclick: () => ((window = key), render()),
          },
          key === "all" ? "All" : key.replace("m", " min"),
        ),
      )
    bar.append(windows)
    if (plan.legend.length >= 2) {
      const legend = h("div", { class: "plot-legend" })
      for (const item of plan.legend)
        legend.append(
          h(
            "button",
            {
              type: "button",
              class: `legend-item${item.hidden ? " is-off" : ""}`,
              "aria-pressed": String(!item.hidden),
              onclick: () => (
                hidden.has(item.name) ? hidden.delete(item.name) : hidden.add(item.name),
                render()
              ),
            },
            h("span", { class: "swatch", style: `background:var(--viz-${item.color})` }),
            item.name,
          ),
        )
      if (plan.overflow > 0)
        legend.append(h("span", { class: "muted", text: `${plan.overflow} more` }))
      bar.append(legend)
    }
    wrap.append(bar)
    if (showTable) return wrap.append(table())
    const grid = h("div", { class: plan.panels.length > 1 ? "plot-multiples" : "" })
    for (const panel of plan.panels) grid.append(chart(panel, plan.directLabels))
    wrap.append(grid)
  }

  return {
    set(next) {
      series = next
    },
    render,
    element: wrap,
  }
}
