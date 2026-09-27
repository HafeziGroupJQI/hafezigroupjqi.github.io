// Shared view pieces.
import { h } from "../dom.js"
import { buildHref } from "../router.js"

export const devicesSorted = (state) =>
  [...state.devices.values()].sort((a, b) => a.code_name.localeCompare(b.code_name))

/** A <select> of devices that navigates the current tab to the chosen one. */
export function devicePicker(ctx, route, label = "Device") {
  const select = h("select", {
    "aria-label": label,
    onchange: (e) =>
      ctx.navigate({ ...route, code: e.target.value || null, id: null, focus: null }),
  })
  const fill = (state) => {
    const codes = devicesSorted(state).map((d) => d.code_name)
    const wanted = ["", ...codes].join("|")
    if (select.dataset.options !== wanted) {
      select.dataset.options = wanted
      select.replaceChildren(
        h("option", { value: "", text: codes.length ? "Choose a device…" : "No devices" }),
        ...codes.map((c) => h("option", { value: c, text: c })),
      )
    }
    select.value = route.code ?? ""
  }
  return { element: h("label", { class: "dash-field" }, h("span", { text: label }), select), fill }
}

export const link = (route, text, attrs = {}) =>
  h("a", { href: buildHref(route), "data-nav": "", ...attrs }, text)

export const empty = (text, ...extra) =>
  h("div", { class: "dash-empty" }, h("p", { text }), ...extra)

/** Placeholder for device-scoped tabs opened without ?code=. */
export function needDevice(ctx, route) {
  const picker = devicePicker(ctx, route)
  return { element: empty("Pick a device to see this tab.", picker.element), fill: picker.fill }
}
