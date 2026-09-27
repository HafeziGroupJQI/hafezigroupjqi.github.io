// Overview tab: every lab PC at a glance. Layouts: grid (cards), list (one row per device),
// focus (list + the selected device's instruments and a mini plot), wall (a lab TV).
import { h, patchList, pill, setClass, setText } from "../dom.js"
import { fmtValue } from "../format.js"
import { LIVENESS_ORDER, ageLabel, ageMs, instrumentLiveness } from "../liveness.js"
import { livePlot } from "../plot.js"
import { LAYOUTS, buildHref } from "../router.js"
import { seriesKey } from "../store.js"
import { link } from "./common.js"

export const WALL_PAGE = 12

export function fleetSummary(devices) {
  const counts = Object.fromEntries(LIVENESS_ORDER.map((l) => [l, 0]))
  for (const d of devices) counts[d.liveness] = (counts[d.liveness] ?? 0) + 1
  const text = LIVENESS_ORDER.filter((l) => counts[l])
    .map((l) => `${counts[l]} ${l}`)
    .join(" · ")
  return { counts, text: text || "No devices yet" }
}

export function overviewModel(state, route) {
  const now = state.now
  const cards = [...state.devices.values()]
    .map((d) => {
      const online = d.liveness === "online"
      return {
        code: d.code_name,
        liveness: d.liveness,
        ageLabel: d.liveness === "pending" ? "never seen" : ageLabel(ageMs(d, now)),
        meta:
          [d.hostname, d.platform, d.agent_version && `v${d.agent_version}`]
            .filter(Boolean)
            .join(" · ") || "not enrolled yet",
        instrumentCount: d.instrument_count ?? 0,
        onlineCount: online ? (d.instruments_online ?? 0) : 0,
        href: buildHref({ tab: "device", code: d.code_name }),
      }
    })
    .sort(
      (a, b) =>
        LIVENESS_ORDER.indexOf(a.liveness) - LIVENESS_ORDER.indexOf(b.liveness) ||
        a.code.localeCompare(b.code),
    )
  const focusCode =
    route.layout === "focus"
      ? cards.some((c) => c.code === route.code)
        ? route.code
        : (cards[0]?.code ?? null)
      : null
  return { cards, summary: fleetSummary(cards), focusCode, loaded: state.devicesLoaded }
}

export const instrumentsLine = (c) =>
  `${c.instrumentCount} instrument${c.instrumentCount === 1 ? "" : "s"}` +
  (c.liveness === "online" ? ` · ${c.onlineCount} online` : "")

function deviceCard(ctx) {
  const node = h("article", { class: "dev-card" })
  const title = h("a", { class: "dev-card-link", "data-nav": "" })
  node.append(
    h(
      "header",
      { class: "dev-card-head" },
      h("span", { class: "dot", "aria-hidden": "true" }),
      title,
      h("span", { "data-pill": "" }),
    ),
    h("p", { class: "dev-meta", "data-meta": "" }),
    h(
      "p",
      { class: "dev-age" },
      h("span", { "aria-hidden": "true", text: "♥ " }),
      h("span", { "data-age": "" }),
    ),
    h("p", { class: "dev-inst", "data-inst": "" }),
    h(
      "div",
      { class: "dev-actions" },
      h("a", { class: "btn", "data-open": "", "data-nav": "", text: "Open" }),
      h("button", {
        type: "button",
        "data-poll": "",
        text: "Poll all",
        onclick: (e) => ctx.pollAll(node.dataset.key, e.currentTarget),
      }),
    ),
  )
  return node
}

function updateCard(node, c) {
  setClass(node, `dev-card live-${c.liveness}`)
  const a = node.querySelector(".dev-card-link")
  setText(a, c.code)
  a.href = c.href
  node.querySelector("[data-open]").href = c.href
  const pillHost = node.querySelector("[data-pill]")
  if (pillHost.textContent !== c.liveness) pillHost.replaceChildren(pill(c.liveness))
  setText(node.querySelector("[data-meta]"), c.meta)
  setText(node.querySelector("[data-age]"), c.ageLabel)
  setText(node.querySelector("[data-inst]"), instrumentsLine(c))
  node.querySelector("[data-poll]").disabled = c.liveness !== "online"
}

function deviceRow() {
  return h(
    "a",
    { class: "dev-row", role: "listitem", "data-nav": "" },
    h("span", { class: "dot", "aria-hidden": "true" }),
    h("strong", { "data-code": "" }),
    h("span", { class: "dev-meta", "data-meta": "" }),
    h("span", { class: "dev-age", "data-age": "" }),
    h("span", { class: "dev-inst", "data-inst": "" }),
    h("span", { "data-pill": "" }),
  )
}

function updateRow(node, c, href) {
  setClass(node, `dev-row live-${c.liveness}${node.dataset.selected === "1" ? " is-selected" : ""}`)
  node.href = href ?? c.href
  setText(node.querySelector("[data-code]"), c.code)
  setText(node.querySelector("[data-meta]"), c.meta)
  setText(node.querySelector("[data-age]"), `♥ ${c.ageLabel}`)
  setText(node.querySelector("[data-inst]"), instrumentsLine(c))
  const pillHost = node.querySelector("[data-pill]")
  if (pillHost.textContent !== c.liveness) pillHost.replaceChildren(pill(c.liveness))
}

export function mountOverview(panel, ctx, route) {
  const layout = route.layout
  const body = h("div", { class: `dash-overview layout-${layout}` })
  panel.append(body)
  const emptyNote = h(
    "div",
    { class: "dash-empty", hidden: true },
    h("p", { text: "No devices yet. Add one to enroll a lab PC." }),
    ctx.canManage
      ? h("button", {
          type: "button",
          class: "primary",
          text: "Add device",
          onclick: () => ctx.addDevice(),
        })
      : null,
  )
  const skeleton = h(
    "div",
    { class: "dev-grid", "aria-busy": "true" },
    [1, 2, 3].map(() => h("div", { class: "dev-card skeleton" })),
  )
  body.append(emptyNote, skeleton)

  let list,
    focusPane,
    plot,
    wallClock,
    wallPage = 0,
    wallTimer
  if (layout === "grid" || layout === "wall")
    list = h("div", { class: layout === "wall" ? "dev-wall" : "dev-grid" })
  else list = h("div", { class: "dev-list", role: "list" })
  if (layout === "focus") {
    focusPane = h("section", { class: "focus-pane", "aria-label": "Selected device" })
    body.append(h("div", { class: "focus-split" }, list, focusPane))
  } else body.append(list)
  if (layout === "wall") {
    wallClock = h("div", { class: "wall-corner", "aria-live": "off" })
    body.append(wallClock)
    wallTimer = setInterval(() => wallPage++, 20_000)
  }

  let lastFocus = null
  function renderFocus(state, model) {
    const code = model.focusCode
    if (!code)
      return focusPane.replaceChildren(h("p", { class: "muted", text: "No device selected." }))
    if (code !== lastFocus) {
      lastFocus = code
      focusPane.replaceChildren(
        h(
          "header",
          { class: "focus-head" },
          h("h2", { text: code }),
          link({ tab: "device", code }, "Open device →"),
        ),
        h("div", { class: "inst-cards", "data-insts": "" }),
        h("div", { "data-plot": "" }),
      )
      plot = livePlot(focusPane.querySelector("[data-plot]"), { mini: true })
    }
    const device = state.devices.get(code)
    const insts = [...(state.instruments.get(code)?.values() ?? [])]
    patchList(
      focusPane.querySelector("[data-insts]"),
      insts,
      (i) => i.local_id,
      () =>
        h(
          "div",
          { class: "inst-mini" },
          h("strong", { "data-t": "" }),
          h("span", { "data-p": "" }),
          h("div", { class: "latest-metrics", "data-l": "" }),
        ),
      (node, inst) => {
        setText(node.querySelector("[data-t]"), inst.title || inst.local_id)
        const status = instrumentLiveness(inst, device?.liveness)
        const p = node.querySelector("[data-p]")
        if (p.textContent !== status) p.replaceChildren(pill(status))
        const metrics = Object.keys(inst.latest ?? {})
        for (const [key, r] of state.latest)
          if (key.startsWith(`${code}|${inst.local_id}|`))
            metrics.includes(key.split("|")[2]) || metrics.push(key.split("|")[2])
        patchList(
          node.querySelector("[data-l]"),
          metrics,
          (m) => m,
          () => h("span"),
          (span, m) => {
            const r = state.latest.get(seriesKey(code, inst.local_id, m))
            setText(span, `${m} ${fmtValue(r?.value, r?.units)}`)
          },
        )
      },
    )
    const first = insts[0]
    if (first && plot) {
      const series = []
      for (const [key, points] of state.series)
        if (key.startsWith(`${code}|${first.local_id}|`))
          series.push({ name: key.split("|")[2], units: state.latest.get(key)?.units, points })
      plot.set(series)
      plot.render()
    }
  }

  let lastFocusRender = 0
  function update(state) {
    const model = overviewModel(state, route)
    skeleton.hidden = model.loaded
    emptyNote.hidden = !model.loaded || model.cards.length > 0
    let cards = model.cards
    if (layout === "wall" && cards.length > WALL_PAGE) {
      const pages = Math.ceil(cards.length / WALL_PAGE)
      const page = wallPage % pages
      cards = cards.slice(page * WALL_PAGE, page * WALL_PAGE + WALL_PAGE)
    }
    if (layout === "grid" || layout === "wall")
      patchList(
        list,
        cards,
        (c) => c.code,
        () => deviceCard(ctx),
        updateCard,
      )
    else
      patchList(
        list,
        cards,
        (c) => c.code,
        deviceRow,
        (node, c) => {
          node.dataset.selected = c.code === model.focusCode ? "1" : "0"
          updateRow(
            node,
            c,
            layout === "focus"
              ? buildHref({ tab: "overview", layout: "focus", code: c.code })
              : null,
          )
        },
      )
    if (wallClock)
      setText(
        wallClock,
        `${new Date(state.now).toLocaleTimeString("en-US", { hour12: false })} · updated ${ageLabel(state.now - ctx.devicesFetchedAt())}`,
      )
    if (focusPane && state.now - lastFocusRender > 900) {
      lastFocusRender = state.now
      renderFocus(state, model)
    } else if (focusPane && model.focusCode !== lastFocus) renderFocus(state, model)
  }

  return {
    update,
    streamCode: () =>
      layout === "focus" ? overviewModel(ctx.store.getState(), route).focusCode : null,
    destroy() {
      clearInterval(wallTimer)
    },
  }
}

export const LAYOUT_LABELS = { grid: "Grid", list: "List", focus: "Focus", wall: "Wall" }
export { LAYOUTS }
