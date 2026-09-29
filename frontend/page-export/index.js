// The Export menu under a page's title, on every content page of both editions (JqiFrame's
// [data-page-tools], whose data-source is the page's Markdown source; static/page-export.js): the
// page as Markdown or Quarto, the file a notebook or Quarto page was rendered from (a Jupyter
// notebook also as Quarto or Markdown, notebook-page/exporting.js), a PDF from the print dialog, and
// the page saved to the member's Google Drive. Which items a page gets: menu.js; the Quarto
// conversion: quarto.js; printing: print.js; Google Drive: drive.js and doc.js. A disclosure menu:
// Enter or Space opens it, the arrow keys move through it, Escape closes it.

import { h } from "../dashboard/dom.js"
import { convertNotebook } from "../notebook-page/exporting.js"
import { GOOGLE_CLIENT_ID } from "./config.js"
import { DOC_LIMIT, articleHtml, docDocument } from "./doc.js"
import { GOOGLE_DOC, colabUrl, driveToken, driveType, loadGis, uploadToDrive } from "./drive.js"
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
      group.note
        ? h(
            "p",
            { class: "page-export__note" },
            `${group.note.text} `,
            h("a", { href: group.note.link.href, text: group.note.link.text }),
          )
        : null,
    ]),
  )
  const details = h("details", { class: "page-export" }, summary, panel)
  // Google's sign-in script loads as the menu first opens, so a click on a Drive item can open its
  // window straight away (browsers let only a click open one).
  if (groups.some((group) => group.items.some((item) => item.id.startsWith("drive-"))))
    details.addEventListener("toggle", () => details.open && loadGis().catch(() => {}), {
      once: true,
    })
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
  const groups = exportItems({ source, rendered: rendered?.name, drive: !!GOOGLE_CLIENT_ID })
  if (!groups.length) return
  const stem = pageStem(source ?? rendered?.name ?? location.pathname)
  const title =
    document.querySelector(".page-content__header h1")?.textContent.trim() ||
    document.title.replace(/ \| Hafezi Group$/, "")
  const pageSource = async () => (await fetchOk(source, "the page's source")).text()
  const fetchRendered = () => fetchOk(rendered.url, rendered.name)
  // Save to Google Drive: sign in first, while the click still counts, then make the file and send
  // it; the status line links to it, and a notebook also to Colab.
  const toDrive = (make) => async (say) => {
    say("Waiting for Google sign-in…")
    const token = await driveToken(GOOGLE_CLIENT_ID)
    say("Preparing…")
    const { metadata, type, body } = await make()
    say("Saving to Google Drive…")
    const file = await uploadToDrive(token, {
      metadata: { ...metadata, description: `From ${location.href}` },
      type,
      body,
    })
    const link = (href, text) => h("a", { href, target: "_blank", rel: "noopener", text })
    return [
      "Saved to Google Drive: ",
      link(file.webViewLink ?? `https://drive.google.com/open?id=${file.id}`, "open it"),
      ...(/\.ipynb$/i.test(file.name) ? [" or ", link(colabUrl(file.id), "open it in Colab")] : []),
    ]
  }
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
    "drive-doc": toDrive(async () => {
      // The member edition's images are members-only: Google gets them inlined.
      const members = !!document.querySelector(".site-internal")
      const markdown = source ? await pageSource().catch(() => null) : null
      const html = docDocument({
        title,
        url: location.href,
        body: await articleHtml(article, { members, source: markdown }),
      })
      const size = new Blob([html]).size
      if (size > DOC_LIMIT)
        throw new Error(
          `the page is ${Math.ceil(size / 2 ** 20)} MB with its images; Google Docs takes 50 MB`,
        )
      return { metadata: { name: title, mimeType: GOOGLE_DOC }, type: "text/html", body: html }
    }),
    "drive-source": toDrive(async () => ({
      metadata: { name: `${stem}.md`, mimeType: driveType(`${stem}.md`) },
      type: driveType(`${stem}.md`),
      body: await pageSource(),
    })),
    "drive-rendered": toDrive(async () => ({
      metadata: { name: rendered.name, mimeType: driveType(rendered.name) },
      type: driveType(rendered.name),
      body: await (await fetchRendered()).blob(),
    })),
  }
  const status = h("span", { class: "wl-status", role: "status" })
  // The latest choice owns the status line; one still waiting (on Google's window, say) is dropped.
  let latest = 0
  const run = async (item) => {
    const mine = ++latest
    const say = (...nodes) => mine === latest && status.replaceChildren(...nodes)
    say("Preparing…")
    try {
      say(...((await actions[item.id](say)) ?? []))
    } catch (error) {
      say(`Export failed: ${error.message}`)
    }
  }
  tools.append(menu(groups, run), status)
  if (article) preparePrint(article)
}

const tools = document.querySelector("[data-page-tools]")
// Not where the page is a member tool (the calendar): it has nothing to export.
if (tools && !document.querySelector(".page-body .member-tools")) mountPageExport(tools)
