// The tools of a notebook or Quarto page (tools/notebooks/, tools/prepare-unified.mjs), above its
// "Rendered from" line (p.wl-source, whose link member-tools.js makes the raw file's download).
// For a file of the private vault, the line's data-source is its path there: "Open notebook in
// Scratchpad". Wolfram notebook pages have theirs on the notebook (frontend/wolfram-notebook/).

import { h } from "../dashboard/dom.js"
import { forkUrl } from "../scratchpad/launch.js"

// Open a vault file in the Scratchpad: the page there starts the member's server (the host only
// knows members who have started one), copies the file into their storage and opens it.
export function openInScratchpad(source, status) {
  status.textContent = "Opening the Scratchpad…"
  location.assign(forkUrl(source))
}

export function mountNotebookPage(bar) {
  const source = bar.dataset.source
  if (!source) return
  const status = h("span", { class: "wl-status", role: "status" })
  bar.before(
    h(
      "div",
      { class: "wl-page-actions" },
      h("button", {
        type: "button",
        text: /\.qmd$/i.test(source)
          ? "Open document in Scratchpad"
          : "Open notebook in Scratchpad",
        onclick: () => openInScratchpad(source, status),
      }),
      status,
    ),
  )
}
