// Experiments tab: cards grouped by status (running first), 20 at a time; the focused one opens.
import { h, patchList, pill, present, setText } from "../dom.js"
import { relTime } from "../format.js"
import { devicePicker, link } from "./common.js"

export const STATUS_ORDER = ["running", "generating", "draft", "stopped", "failed"]
export const PAGE = 20

export function experimentsModel(state, route, limit = PAGE) {
  const rows = state.experiments.get(route.code ?? "*")
  if (!rows) return { loaded: false, groups: [], total: 0, more: 0, active: false }
  const shown = [...rows].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      String(b.created_ns).localeCompare(String(a.created_ns)),
  )
  const visible = shown.slice(
    0,
    Math.max(limit, route.focus ? shown.findIndex((r) => r.id === route.focus) + 1 : 0),
  )
  const groups = STATUS_ORDER.concat(
    [...new Set(rows.map((r) => r.status))].filter((s) => !STATUS_ORDER.includes(s)),
  )
    .map((status) => ({
      status,
      items: visible
        .filter((r) => r.status === status)
        .map((r) => ({
          id: r.id,
          label: r.label || r.id,
          status: r.status,
          device: r.device_code ?? route.code,
          created: relTime(r.created_ns, state.now),
          open: r.id === route.focus,
        })),
    }))
    .filter((g) => g.items.length)
  return {
    loaded: true,
    groups,
    total: rows.length,
    more: rows.length - visible.length,
    active: rows.some((r) => r.status === "running" || r.status === "generating"),
  }
}

export function mountExperiments(panel, ctx, route) {
  let limit = PAGE
  const picker = devicePicker(ctx, route, "Device (all when empty)")
  const body = h("div", { class: "experiment-list" })
  const more = h("button", {
    type: "button",
    hidden: true,
    onclick: () => ((limit += PAGE), update(ctx.store.getState())),
  })
  panel.append(
    h(
      "div",
      { class: "dash-section-head" },
      h("h2", { text: route.code ? `Experiments · ${route.code}` : "Experiments · all devices" }),
      h("span", { class: "spacer" }),
      picker.element,
      link({ tab: "builder", code: route.code }, "Build an experiment", { class: "btn primary" }),
    ),
    body,
    more,
  )

  function card(item) {
    const details = h("details", { class: "experiment-card" })
    const bodyEl = h(
      "div",
      { class: "experiment-body" },
      h("p", { class: "muted", text: "Loading…" }),
    )
    details.append(
      h(
        "summary",
        {},
        h("code", { "data-label": "" }),
        h("span", { class: "muted", "data-when": "" }),
        h("span", { "data-pill": "" }),
      ),
      bodyEl,
    )
    const load = async () => {
      if (!details.open || details.dataset.loaded) return
      details.dataset.loaded = "1"
      try {
        const full = await ctx.api(`/api/experiments/${encodeURIComponent(item.id)}`)
        bodyEl.replaceChildren(
          ...present(
            h("p", { text: full.spec?.experiment_prompt || "" }),
            h("p", {
              class: "muted",
              text: `id ${full.id}${item.device ? " · device " + item.device : ""}`,
            }),
            full.status === "running" && item.device
              ? h("button", {
                  type: "button",
                  class: "danger",
                  text: "Stop",
                  onclick: (e) => ctx.stopExperiment(item.device, full.id, e.currentTarget),
                })
              : null,
            h("pre", { class: "script", text: full.script || "(script pending)" }),
          ),
        )
      } catch (error) {
        details.dataset.loaded = ""
        bodyEl.replaceChildren(h("p", { role: "alert", text: error.message }))
      }
    }
    details.addEventListener("toggle", load)
    if (item.open) {
      details.open = true
      queueMicrotask(() => {
        load()
        details.scrollIntoView({ block: "nearest" })
      })
    }
    return details
  }

  function update(state) {
    picker.fill(state)
    const m = experimentsModel(state, route, limit)
    if (!m.loaded)
      return body.replaceChildren(
        h("p", { class: "muted", "aria-busy": "true", text: "Loading experiments…" }),
      )
    if (!m.total)
      return body.replaceChildren(
        h(
          "div",
          { class: "dash-empty" },
          h("p", { text: "No experiments yet. Build one to get started." }),
        ),
      )
    patchList(
      body,
      m.groups,
      (g) => g.status,
      (g) =>
        h(
          "section",
          { class: "exp-group" },
          h("h3", {}, pill(g.status), h("span", { class: "muted", "data-count": "" })),
          h("div", { "data-items": "" }),
        ),
      (node, g) => {
        setText(node.querySelector("[data-count]"), ` ${g.items.length}`)
        patchList(
          node.querySelector("[data-items]"),
          g.items,
          (i) => i.id,
          card,
          (el, i) => {
            setText(el.querySelector("[data-label]"), i.label)
            setText(
              el.querySelector("[data-when]"),
              `${i.device && !route.code ? i.device + " · " : ""}${i.created}`,
            )
            const p = el.querySelector("[data-pill]")
            if (p.textContent !== i.status) p.replaceChildren(pill(i.status))
          },
        )
      },
    )
    more.hidden = m.more <= 0
    more.textContent = `Show ${Math.min(PAGE, m.more)} more`
  }
  return { update, streamCode: () => null }
}
