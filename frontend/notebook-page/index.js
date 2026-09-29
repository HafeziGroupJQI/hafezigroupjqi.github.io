// The tools of a notebook or Quarto page (tools/notebooks/, tools/prepare-unified.mjs), above its
// "Rendered from" line (p.wl-source, whose link member-tools.js makes the raw file's download).
// For a file of the private vault, the line's data-source is its path there: "Open notebook in
// Scratchpad". Wolfram notebook pages have theirs on the notebook (frontend/wolfram-notebook/).
// A Jupyter notebook also downloads as Quarto or Markdown, converted here from the raw file.

import { h } from "../dashboard/dom.js"
import { save } from "../page-export/save.js"
import { forkUrl } from "../scratchpad/launch.js"
import { convertNotebook, downloadFormats } from "./exporting.js"

// Open a vault file in the Scratchpad: the page there starts the member's server (the host only
// knows members who have started one), copies the file into their storage and opens it.
export function openInScratchpad(source, status) {
  status.textContent = "Opening the Scratchpad…"
  location.assign(forkUrl(source))
}

// "Download as": the raw file is the page's own link; the others are converted from it.
function downloadControls(link, name, formats, status) {
  const select = h(
    "select",
    {},
    formats.map(({ format, label }) => h("option", { value: format, text: label })),
  )
  const button = h("button", { type: "button", text: "Download" })
  button.onclick = async () => {
    if (select.value === formats[0].format) return link.click()
    button.disabled = true
    status.textContent = "Converting…"
    try {
      const response = await fetch(link.href, { cache: "no-store" })
      if (!response.ok) throw new Error(`the notebook did not load (${response.status})`)
      save(convertNotebook(await response.text(), select.value, name))
      status.textContent = ""
    } catch (error) {
      status.textContent = `Download failed: ${error.message}`
    } finally {
      button.disabled = false
    }
  }
  return [h("label", {}, "Download as ", select), button]
}

export function mountNotebookPage(bar) {
  const source = bar.dataset.source
  const link = bar.querySelector("a[href]")
  const name = link?.textContent.trim() ?? ""
  const formats = link ? downloadFormats(name) : []
  if (!source && !formats.length) return
  const status = h("span", { class: "wl-status", role: "status" })
  bar.before(
    h(
      "div",
      { class: "wl-page-actions" },
      source
        ? h("button", {
            type: "button",
            text: /\.qmd$/i.test(source)
              ? "Open document in Scratchpad"
              : "Open notebook in Scratchpad",
            onclick: () => openInScratchpad(source, status),
          })
        : null,
      formats.length ? downloadControls(link, name, formats, status) : null,
      status,
    ),
  )
}
