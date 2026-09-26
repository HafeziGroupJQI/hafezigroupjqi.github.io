// Activity tab: the device's command audit log (GET …/commands), rendered for the first time —
// one card per command with its queued → sent → done timeline; SSE command_result updates it live.
import { h, patchList, pill, setText } from "../dom.js"
import { argsSummary, nsToMs } from "../format.js"
import { devicePicker, needDevice } from "./common.js"

export const PAGE = 30

const at = (ns) => {
  const ms = nsToMs(ns)
  return ms == null ? null : new Date(ms).toLocaleTimeString("en-US", { hour12: false })
}

export function activityModel(state, route, limit = PAGE) {
  const rows = state.commands.get(route.code)
  if (!rows) return { loaded: false, items: [], more: 0 }
  const items = rows.slice(0, limit).map((c) => {
    const final = c.status === "failed" ? "failed" : "done"
    return {
      id: c.id,
      kind: c.kind,
      args: argsSummary(c.args),
      by: c.requested_by || "—",
      status: c.status,
      steps: [
        { name: "queued", at: at(c.created_ns), reached: true },
        { name: "sent", at: at(c.delivered_ns), reached: c.status !== "queued" },
        { name: final, at: at(c.completed_ns), reached: c.status === "done" || c.status === "failed" },
      ],
      result: c.result != null ? JSON.stringify(c.result).slice(0, 200) : "",
    }
  })
  return { loaded: true, items, more: Math.max(0, rows.length - limit) }
}

export function mountActivity(panel, ctx, route) {
  if (!route.code) {
    const need = needDevice(ctx, route)
    panel.append(need.element)
    return { update: need.fill }
  }
  let limit = PAGE
  const picker = devicePicker(ctx, route)
  const list = h("ol", { class: "activity-list" })
  const more = h("button", { type: "button", hidden: true, onclick: () => ((limit += PAGE), update(ctx.store.getState())) })
  panel.append(h("div", { class: "dash-section-head" }, h("h2", { text: `Activity · ${route.code}` }), h("span", { class: "spacer" }), picker.element), list, more)

  function update(state) {
    picker.fill(state)
    const m = activityModel(state, route, limit)
    if (!m.loaded) return list.replaceChildren(h("li", { class: "muted", text: "Loading commands…" }))
    if (!m.items.length) return list.replaceChildren(h("li", { class: "dash-empty", text: "No commands yet. Poll an instrument from the Device tab." }))
    patchList(list, m.items, (i) => i.id,
      () => h("li", { class: "cmd-card" },
        h("header", {}, h("strong", { class: "mono", "data-kind": "" }), h("span", { class: "muted", "data-args": "" }), h("span", { class: "spacer" }), h("span", { "data-pill": "" })),
        h("ol", { class: "cmd-steps", "data-steps": "" }),
        h("p", { class: "muted", "data-foot": "" })),
      (node, i) => {
        setText(node.querySelector("[data-kind]"), i.kind)
        setText(node.querySelector("[data-args]"), i.args)
        const p = node.querySelector("[data-pill]")
        if (p.textContent !== i.status) p.replaceChildren(pill(i.status))
        patchList(node.querySelector("[data-steps]"), i.steps, (s) => s.name, () => h("li"), (li, s) => {
          li.className = s.reached ? `reached step-${s.name}` : "pending"
          setText(li, s.at ? `${s.name} ${s.at}` : s.name)
        })
        setText(node.querySelector("[data-foot]"), `by ${i.by}${i.result ? " · " + i.result : ""}`)
      })
    more.hidden = m.more <= 0
    more.textContent = `Show ${Math.min(PAGE, m.more)} more`
  }
  return { update, streamCode: () => route.code }
}
