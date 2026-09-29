// The Export menu under a page's title, on every content page of both editions (JqiFrame's
// [data-page-tools], whose data-source is the page's Markdown source; static/page-export.js): the
// page as Markdown or Quarto, the file a notebook or Quarto page was rendered from (a Jupyter
// notebook also as Quarto or Markdown, notebook-page/exporting.js), and a PDF from the print dialog.
// Which items a page gets: menu.js; the Quarto conversion: quarto.js; printing: print.js. A
// disclosure menu: Enter or Space opens it, the arrow keys move through it, Escape closes it.

import { h } from "../dashboard/dom.js"
import { convertNotebook } from "../notebook-page/exporting.js"
import { exportItems, pageStem } from "./menu.js"
import { preparePrint } from "./print.js"
import { markdownToQmd } from "./quarto.js"
import { save } from "./save.js"

/* global fetchData */

const MARKDOWN = "text/markdown;charset=utf-8"

async function fetchOk(url, what) {
  let response
  try {
    response = await fetch(url, { cache: "no-store" })
  } catch {
    throw new Error(navigator.onLine ? `${what} did not load` : "you are offline")
  }
  if (!response.ok) throw new Error(`${what} did not load (${response.status})`)
  return response
}

// The site's paths for resolving the page's links as Quartz did: its content index (which the
// page's head already fetches, as the global fetchData) and the files the article shows.
async function siteSlugs(article) {
  const index = typeof fetchData === "undefined" ? {} : await fetchData.catch(() => ({}))
  const files = [...(article?.querySelectorAll("img[src], a[href]") ?? [])]
    .map((node) => new URL(node.src || node.href, location.href))
    .filter((url) => url.origin === location.origin)
    .map((url) => decodeURIComponent(url.pathname).replace(/^\/+/, ""))
  return [...Object.keys(index), ...files]
}

// The file a notebook or Quarto page was rendered from: its "Rendered from" link. ?raw fetches the
// file itself where the members service worker would show its page.
function renderedFile(article) {
  const link = article?.querySelector("p.wl-source a[href]")
  if (!link) return null
  const url = new URL(link.href, location.href)
  url.searchParams.set("raw", "1")
  return { name: link.textContent.trim(), url: url.pathname + url.search }
}

function menu(groups, run) {
  const summary = h("summary", { "aria-label": "Export this page", text: "Export" })
  const panel = h(
    "div",
    { class: "page-export__panel" },
    groups.flatMap((group, index) => [
      h("p", { class: "page-export__heading", id: `page-export-${index}`, text: group.label }),
      h(
        "ul",
        { "aria-labelledby": `page-export-${index}` },
        group.items.map((item) =>
          h(
            "li",
            {},
            h("button", {
              type: "button",
              text: item.label,
              onclick: () => {
                details.open = false
                summary.focus()
                run(item)
              },
            }),
          ),
        ),
      ),
    ]),
  )
  const details = h("details", { class: "page-export" }, summary, panel)
  details.addEventListener("keydown", (event) => {
    const buttons = [...panel.querySelectorAll("button:not(:disabled)")]
    if (event.key === "Escape" && details.open) {
      event.preventDefault()
      details.open = false
      summary.focus()
      return
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !buttons.length) return
    event.preventDefault()
    details.open = true
    const at = buttons.indexOf(document.activeElement)
    const last = buttons.length - 1
    const next = {
      Home: 0,
      End: last,
      ArrowDown: at < 0 || at === last ? 0 : at + 1,
      ArrowUp: at <= 0 ? last : at - 1,
    }[event.key]
    buttons[next].focus()
  })
  document.addEventListener("click", (event) => {
    if (details.open && !details.contains(event.target)) details.open = false
  })
  return details
}

export function mountPageExport(tools) {
  const article = document.querySelector(".page-body")
  const source = tools.dataset.source || null
  const rendered = renderedFile(article)
  const groups = exportItems({ source, rendered: rendered?.name })
  if (!groups.length) return
  const stem = pageStem(source ?? rendered?.name ?? location.pathname)
  const title =
    document.querySelector(".page-content__header h1")?.textContent.trim() ||
    document.title.replace(/ \| Hafezi Group$/, "")
  const pageSource = async () => (await fetchOk(source, "the page's source")).text()
  const fetchRendered = () => fetchOk(rendered.url, rendered.name)
  const notebookAs = (format) => async () =>
    save(convertNotebook(await (await fetchRendered()).text(), format, rendered.name))
  const actions = {
    source: async () => save({ name: `${stem}.md`, type: MARKDOWN, text: await pageSource() }),
    quarto: async () => {
      const text = markdownToQmd(await pageSource(), {
        title,
        slug: document.body.dataset.slug ?? stem,
        origin: location.origin,
        allSlugs: await siteSlugs(article),
      })
      save({ name: `${stem}.qmd`, type: MARKDOWN, text })
    },
    rendered: async () => save({ name: rendered.name, text: await (await fetchRendered()).blob() }),
    "notebook-qmd": notebookAs("qmd"),
    "notebook-md": notebookAs("md"),
    // The browser's print dialog, whose destination "Save as PDF" makes the file.
    pdf: async () => print(),
  }
  const status = h("span", { class: "wl-status", role: "status" })
  let busy = false
  const run = async (item) => {
    if (busy) return
    busy = true
    status.textContent = "Preparing…"
    try {
      await actions[item.id]()
      status.textContent = ""
    } catch (error) {
      status.textContent = `Export failed: ${error.message}`
    } finally {
      busy = false
    }
  }
  tools.append(menu(groups, run), status)
  if (article) preparePrint(article)
}

const tools = document.querySelector("[data-page-tools]")
// Not where the page is a member tool (the calendar): it has nothing to export.
if (tools && !document.querySelector(".page-body .member-tools")) mountPageExport(tools)
