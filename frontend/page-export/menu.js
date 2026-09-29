// The Export menu of a page (frontend/page-export/index.js): which items it has, by what the page
// has. Pure, so node:test covers it.
//   source    the page's Markdown source, beside its HTML (quartz/plugins/local/page-source/):
//             every content page has one
//   rendered  the file a notebook or Quarto page was made from, by its name (the page's
//             "Rendered from" link): .ipynb, .qmd or .nb

import { downloadFormats } from "../notebook-page/exporting.js"

/** A download's name without its extension: the page's file, or its folder's for an index page. */
export function pageStem(sourcePath) {
  const segments = decodeURIComponent(sourcePath).replace(/\.md$/i, "").split("/").filter(Boolean)
  const last = segments.pop() ?? "page"
  return (last === "index" && segments.length ? segments.pop() : last) || "page"
}

const extension = (name) => name?.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() ?? ""

/**
 * The menu's groups, each {label, items: [{id, label}]}, in order; groups without items are left
 * out. Item ids name what index.js does:
 *   source    the page's Markdown source          quarto  that source converted to Quarto
 *   rendered  the file the page was rendered from pdf     the print dialog (print.js)
 *   notebook-qmd, notebook-md  a Jupyter notebook converted (notebook-page/exporting.js)
 */
export function exportItems({ source = null, rendered = null } = {}) {
  const kind = extension(rendered)
  const download = []
  // A Jupyter notebook's page downloads as the notebook, or converted from it as the lab's Export
  // converts it: its page's own Markdown is Quarto's rendering, with the figures beside it.
  const notebook = downloadFormats(rendered ?? "")
  notebook.forEach(({ format, label }, index) =>
    download.push({ id: index ? `notebook-${format}` : "rendered", label }),
  )
  if (kind === "qmd") download.push({ id: "rendered", label: "Quarto (.qmd)" })
  // A Wolfram notebook's page is the notebook drawn in HTML: its Markdown would be that HTML.
  if (source && !["nb", "ipynb"].includes(kind))
    download.push({ id: "source", label: "Markdown (.md)" })
  if (source && !kind) download.push({ id: "quarto", label: "Quarto (.qmd)" })
  if (kind === "nb") download.push({ id: "rendered", label: "Wolfram notebook (.nb)" })
  download.push({ id: "pdf", label: "Save as PDF…" })
  return [{ label: "Download", items: download }].filter((group) => group.items.length)
}
