// A page's article as an HTML document for Google Docs to import ("Save to Google Drive" as a
// Google Doc, drive.js): the article without the site's controls, equations as their TeX, code as
// plain text, every link and image with its full URL. Images Google can't fetch (a member page's,
// which only members can) or can't import (SVG, drawn to PNG here) go in the document as data:
// URLs, as the notebook export inlines its figures (notebook-page/exporting.js, inlineFigures).

/** Drive converts a document of at most this many bytes to a Google Doc. */
export const DOC_LIMIT = 50 * 1024 * 1024

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  )

/** The document: the page's title, where it came from, and the article's HTML. Pure. */
export function docDocument({ title, url, body }) {
  return [
    "<!doctype html>",
    `<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>`,
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>From <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
    body,
    "</body></html>",
  ].join("\n")
}

/** An equation as its TeX between Pandoc's (and Quarto's) delimiters. Pure. */
export const texText = (tex, display) => (display ? `$$${tex.trim()}$$` : `$${tex.trim()}$`)

/**
 * The equations of a page's Markdown source, in order, as remark-math reads them ($$…$$, and $…$
 * on one line), outside code and comments. The site's KaTeX keeps no TeX in the page (output:
 * "html"), so the Google Doc takes each equation's TeX from here, when the counts agree. Pure.
 */
export function sourceMath(markdown) {
  const text = markdown
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, "")
    .replace(/(`+)[\s\S]*?\1/g, "")
    .replace(/%%[\s\S]*?%%|<!--[\s\S]*?-->/g, "")
  return [...text.matchAll(/\$\$([\s\S]+?)\$\$|(?<!\\)\$((?:\\.|[^$\n])+?)\$/g)].map(
    ([, display, inline]) => (display === undefined ? inline : display).trim(),
  )
}

/** Whether an image goes in as a data: URL: Google can't fetch it, or can't import it. Pure. */
export function inlineImage(src, { page, members }) {
  const url = new URL(src, page)
  if (url.protocol === "data:") return false
  const svg = /\.svg$/i.test(url.pathname)
  return svg || (members && url.origin === new URL(page).origin)
}

// The site's own controls and anything that doesn't print.
const REMOVE = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "button",
  "input",
  "select",
  "textarea",
  "dialog",
  ".wl-page-actions",
  ".wl-toolbar",
  ".wl-status",
  ".external-icon",
  ".popover",
].join(",")

const blobDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

// An SVG drawn to a PNG at twice its size (at most 4000 px a side), on white.
async function svgPng(svg, width, height) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }))
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const w = width || image.naturalWidth || 800
    const h = height || image.naturalHeight || 600
    const scale = Math.min(2, 4000 / Math.max(w, h))
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    const context = canvas.getContext("2d")
    context.fillStyle = "#fff"
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return { src: canvas.toDataURL("image/png"), width: Math.round(w) }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function imageData(src, width) {
  const response = await fetch(src)
  if (!response.ok) throw new Error(`${src}: ${response.status}`)
  const blob = await response.blob()
  if (blob.type === "image/svg+xml" || /\.svg$/i.test(new URL(src).pathname))
    return svgPng(await blob.text(), width)
  return { src: await blobDataUrl(blob) }
}

/**
 * The article's HTML for the document. `members`: the page is the member edition's, whose images
 * only members can fetch (an image that can't be inlined keeps its URL); `source`: the page's
 * Markdown, for its equations.
 */
export async function articleHtml(article, { members, source }) {
  const copy = article.cloneNode(true)
  // Drawings inline in the page (Excalidraw, Mermaid) become pictures; small ones are icons.
  const live = [...article.querySelectorAll("svg")]
  const drawings = [...copy.querySelectorAll("svg")].map((svg, index) => [svg, live[index]])
  await Promise.all(
    drawings.map(async ([svg, shown]) => {
      const { width, height } = shown?.getBoundingClientRect() ?? {}
      if (!(width >= 48 && height >= 48) || svg.closest(`${REMOVE}, .katex`)) return
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg")
      try {
        const png = await svgPng(new XMLSerializer().serializeToString(svg), width, height)
        const image = document.createElement("img")
        image.src = png.src
        image.width = png.width
        svg.replaceWith(image)
      } catch {
        svg.remove()
      }
    }),
  )
  for (const node of copy.querySelectorAll(REMOVE)) node.remove()
  for (const svg of copy.querySelectorAll("svg")) svg.remove()
  // Each equation (a display one's .katex sits in its .katex-display) as its TeX: KaTeX's MathML
  // annotation where the page has it, else the source's equation in the same place.
  const equations = [
    ...new Set(
      [...copy.querySelectorAll(".katex")].map((math) => math.closest(".katex-display") ?? math),
    ),
  ]
  const texs = sourceMath(source ?? "")
  equations.forEach((math, index) => {
    const display = math.classList.contains("katex-display")
    const tex =
      math.querySelector('annotation[encoding="application/x-tex"]')?.textContent ??
      (texs.length === equations.length ? texs[index] : null)
    const text = document.createElement(display ? "p" : "span")
    text.textContent = tex ? texText(tex, display) : math.textContent
    math.replaceWith(text)
  })
  for (const code of copy.querySelectorAll("pre code")) {
    const lines = [...code.querySelectorAll("[data-line]")]
    code.textContent = lines.length
      ? lines.map((line) => line.textContent).join("\n")
      : code.textContent
  }
  // Folded sections open: Google Docs has no folding.
  for (const details of copy.querySelectorAll("details")) {
    const summary = details.querySelector(":scope > summary")
    const block = document.createElement("div")
    if (summary) {
      const heading = document.createElement("p")
      heading.append(document.createElement("strong"))
      heading.firstChild.append(...summary.childNodes)
      summary.replaceWith(heading)
    }
    block.append(...details.childNodes)
    details.replaceWith(block)
  }
  for (const link of copy.querySelectorAll("a[href]")) link.setAttribute("href", link.href)
  await Promise.all(
    [...copy.querySelectorAll("img[src]")].map(async (image) => {
      const src = image.src
      image.removeAttribute("srcset")
      image.removeAttribute("loading")
      for (const size of ["width", "height"])
        if (!/^\d+$/.test(image.getAttribute(size) ?? "")) image.removeAttribute(size)
      image.setAttribute("src", src)
      if (!inlineImage(src, { page: location.href, members })) return
      try {
        const data = await imageData(src, Number(image.getAttribute("width")) || 0)
        image.setAttribute("src", data.src)
        if (data.width && !image.hasAttribute("width")) image.setAttribute("width", data.width)
      } catch {
        // Kept as its URL.
      }
    }),
  )
  for (const node of copy.querySelectorAll("*"))
    for (const name of node.getAttributeNames())
      if (name.startsWith("data-") || name === "style" || name === "class")
        node.removeAttribute(name)
  return copy.innerHTML
}
