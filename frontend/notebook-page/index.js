// The own action of a notebook or Quarto page (tools/notebooks/, tools/prepare-unified.mjs): for a
// file of the private vault, whose "Rendered from" line (p.wl-source) names its path there in
// data-source, "Open notebook in Scratchpad". It goes in the page's tools row under its title, beside
// the Export menu (frontend/page-export/), which downloads the notebook and converts it with
// exporting.js. Wolfram notebook pages put theirs there too (frontend/wolfram-notebook/).

import { h } from "../dashboard/dom.js"
import { forkUrl } from "../scratchpad/launch.js"

// Open a vault file in the Scratchpad: the page there starts the member's server (the host only
// knows members who have started one), copies the file into their storage and opens it.
export function openInScratchpad(source, status) {
  status.textContent = "Opening the Scratchpad…"
  location.assign(forkUrl(source))
}

/**
 * Put a page's own actions first in its tools row (JqiFrame's [data-page-tools]); a page without
 * one gets them in a row of their own, which `place` puts on the page.
 */
export function placePageActions(nodes, place) {
  const tools = document.querySelector("[data-page-tools]")
  if (tools) tools.prepend(...nodes)
  else place(h("div", { class: "wl-page-actions" }, nodes))
}

export function mountNotebookPage(bar) {
  const source = bar.dataset.source
  if (!source) return
  const status = h("span", { class: "wl-status", role: "status" })
  const button = h("button", {
    type: "button",
    text: /\.qmd$/i.test(source) ? "Open document in Scratchpad" : "Open notebook in Scratchpad",
    onclick: () => openInScratchpad(source, status),
  })
  placePageActions([button, status], (row) => bar.before(row))
}
