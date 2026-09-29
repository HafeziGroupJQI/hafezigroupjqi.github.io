// The Export menu of a page (frontend/page-export/index.js): which items it has, by what the page
// has. Pure, so node:test covers it.
//   source    the page's Markdown source, beside its HTML (quartz/plugins/local/page-source/):
//             every content page has one
//   rendered  the file a notebook or Quarto page was made from, by its name (the page's
//             "Rendered from" link): .ipynb, .qmd or .nb
//   drive     whether the site has a Google OAuth client for Save to Google Drive (config.js)

import { downloadFormats } from "../notebook-page/exporting.js"

/** A download's name without its extension: the page's file, or its folder's for an index page. */
export function pageStem(sourcePath) {
  const segments = decodeURIComponent(sourcePath).replace(/\.md$/i, "").split("/").filter(Boolean)
  const last = segments.pop() ?? "page"
  return (last === "index" && segments.length ? segments.pop() : last) || "page"
}

const extension = (name) => name?.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() ?? ""

/**
 * The menu's groups, each {label, items: [{id, label}], note?: {text, link: {href, text}}}, in
 * order; groups without items are left out. Item ids name what index.js does:
 *   source    the page's Markdown source          quarto  that source converted to Quarto
 *   rendered  the file the page was rendered from pdf     the print dialog (print.js)
 *   notebook-qmd, notebook-md  a Jupyter notebook converted (notebook-page/exporting.js)
 *   drive-doc  the article as a Google Doc        drive-source, drive-rendered  those files, to Drive
 */
export function exportItems({ source = null, rendered = null, drive = false } = {}) {
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
  // To the member's Google Drive: the article as a Google Doc, and the page's file as it is (a
  // Jupyter notebook opens from Drive in Colab).
  const saved = {
    ipynb: "As the notebook (.ipynb), for Colab",
    qmd: "As the Quarto file (.qmd)",
    nb: "As the Wolfram notebook (.nb)",
  }[kind]
  const toDrive = drive
    ? [
        { id: "drive-doc", label: "As a Google Doc" },
        saved
          ? { id: "drive-rendered", label: saved }
          : source && { id: "drive-source", label: "As Markdown (.md)" },
      ].filter(Boolean)
    : []
  return [
    { label: "Download", items: download },
    {
      label: "Save to Google Drive",
      items: toDrive,
      // What Google's window will ask for, said before it asks.
      note: {
        text: "Google asks once to let this site save files to your Drive; it sees only those.",
        link: { href: "/privacy", text: "Privacy" },
      },
    },
  ].filter((group) => group.items.length)
}
