// A page's article as an HTML document for Google Docs to import ("Save to Google Drive" as a
// Google Doc, drive.js): the article without the site's controls, equations as their TeX, code as
// plain text, every link with its full URL, embeds as links (print.js's notes). Every picture goes
// in the document itself, as the notebook export inlines its figures
// (notebook-page/exporting.js, inlineFigures): as a PNG or JPEG (drawings and WebP drawn to PNG
// here: Docs imports neither SVG nor WebP), with its size set to fit a page, so no figure runs off
// it. Tables span the page's width.

import { embedNote } from "./print.js"

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

/**
 * The largest picture in the document, in CSS px (Docs reads them at 96 dpi): 600 × 800 fits the
 * text of a Letter page and of an A4 one inside Docs' 1 in margins (6.5 in and 6.27 in wide).
 */
export const DOC_MAX = { width: 600, height: 800 }
/** Docs takes pictures of at most 25 megapixels. */
export const DOC_PIXELS = 25_000_000

/**
 * A picture's size in the document: its size on the page (`shown`, else its own, `natural`), in
 * its own proportions, scaled down to fit `max` (a table cell's share of the page in a table).
 * Pure.
 */
export function docImageSize({ natural, shown = null, max = DOC_MAX }) {
  const own = natural?.width > 0 && natural?.height > 0 ? natural : null
  const base = shown?.width > 0 && shown?.height > 0 ? shown : (own ?? { width: 300, height: 150 })
  const ratio = own ? own.height / own.width : base.height / base.width
  const scale = Math.min(1, max.width / base.width, max.height / (base.width * ratio))
  return {
    width: Math.max(1, Math.round(base.width * scale)),
    height: Math.max(1, Math.round(base.width * ratio * scale)),
  }
}

/**
 * The pixels to send for a picture shown at `size`: twice that (sharp on dense screens and in
 * print), never more than it has (`natural`; a drawing has any), and at most 25 megapixels. Pure.
 */
export function docPixels({ natural = null, size }) {
  let width = Math.min(size.width * 2, natural?.width > 0 ? natural.width : Infinity)
  let height = (width * size.height) / size.width
  const scale = Math.min(1, Math.sqrt(DOC_PIXELS / (width * height)))
  width = Math.max(1, Math.floor(width * scale))
  height = Math.max(1, Math.floor(height * scale))
  return { width, height }
}

/** The format a picture is redrawn in: a JPEG photo stays JPEG; anything else becomes PNG. Pure. */
export const docImageFormat = (type) => (/^image\/jpe?g$/i.test(type) ? "image/jpeg" : "image/png")

/** A picture Docs takes as it is: PNG, JPEG or GIF, with no more pixels than it needs. Pure. */
export const docKeepsImage = ({ type, natural, pixels }) =>
  /^image\/(?:png|jpeg|gif)$/i.test(type) &&
  natural.width <= pixels.width &&
  natural.width * natural.height <= DOC_PIXELS

/** A table cell's share of the page's width, for a picture in it: its row's columns, less padding. */
export const cellMax = (columns) => ({
  width: Math.max(48, Math.floor(DOC_MAX.width / Math.max(1, columns)) - 12),
  height: DOC_MAX.height,
})

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

// A picture as the document takes it: {src (a data: URL), width, height}, drawn again (at
// docPixels, as PNG or JPEG, a drawing on white as the page shows it) unless Docs takes it as it is.
async function docPicture(blob, { shown, max }) {
  const drawing = blob.type === "image/svg+xml"
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const own = { width: image.naturalWidth, height: image.naturalHeight }
    const natural = own.width && own.height ? own : null
    const size = docImageSize({ natural, shown, max })
    const pixels = docPixels({ natural: drawing ? null : natural, size })
    if (!drawing && natural && docKeepsImage({ type: blob.type, natural, pixels }))
      return { src: await blobDataUrl(blob), ...size }
    const canvas = document.createElement("canvas")
    canvas.width = pixels.width
    canvas.height = pixels.height
    const context = canvas.getContext("2d")
    const type = drawing ? "image/png" : docImageFormat(blob.type)
    if (drawing || type === "image/jpeg") {
      context.fillStyle = "#fff"
      context.fillRect(0, 0, canvas.width, canvas.height)
    }
    context.imageSmoothingQuality = "high"
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return { src: canvas.toDataURL(type, 0.9), ...size }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function fetchPicture(src) {
  const response = await fetch(src)
  if (!response.ok) throw new Error(`${src}: ${response.status}`)
  const blob = await response.blob()
  // A server may call an SVG something else; drawn from a Blob, it must say it is one.
  return /\.svg$/i.test(new URL(src, location.href).pathname) && blob.type !== "image/svg+xml"
    ? new Blob([blob], { type: "image/svg+xml" })
    : blob
}

const setPicture = (image, { src, width, height }) => {
  image.setAttribute("src", src)
  image.setAttribute("width", String(width))
  image.setAttribute("height", String(height))
  image.setAttribute("style", `width:${width}px;height:${height}px`)
}

// A picture in a table gets its column's share of the width.
const pictureMax = (image) => {
  const table = image.closest("table")
  if (!table) return DOC_MAX
  const columns = Math.max(...[...table.rows].map((row) => row.cells.length), 1)
  return cellMax(columns)
}

const box = (element) => {
  const { width, height } = element?.getBoundingClientRect() ?? {}
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * The article's HTML for the document. `source`: the page's Markdown, for its equations.
 */
export async function articleHtml(article, { source } = {}) {
  const copy = article.cloneNode(true)
  // Each picture's size on the page, by position (the copy's pictures are the article's).
  const liveImages = [...article.querySelectorAll("img")]
  const images = [...copy.querySelectorAll("img")].map((image, index) => [image, liveImages[index]])
  // Drawings inline in the page (Excalidraw, Mermaid) become pictures; small ones are icons.
  const live = [...article.querySelectorAll("svg")]
  const drawings = [...copy.querySelectorAll("svg")].map((svg, index) => [svg, live[index]])
  await Promise.all(
    drawings.map(async ([svg, shownSvg]) => {
      const shown = box(shownSvg)
      if (!(shown?.width >= 48 && shown?.height >= 48) || svg.closest(`${REMOVE}, .katex`)) return
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg")
      if (!svg.hasAttribute("viewBox"))
        svg.setAttribute("viewBox", `0 0 ${Math.round(shown.width)} ${Math.round(shown.height)}`)
      try {
        const text = new XMLSerializer().serializeToString(svg)
        const picture = await docPicture(new Blob([text], { type: "image/svg+xml" }), {
          shown,
          max: pictureMax(svg),
        })
        const image = document.createElement("img")
        setPicture(image, picture)
        svg.replaceWith(image)
      } catch {
        svg.remove()
      }
    }),
  )
  // Embeds become their note's link (print.js); Docs has no players or frames.
  for (const embed of copy.querySelectorAll("iframe, video, audio")) {
    const src = embed.getAttribute("src")
      ? new URL(embed.getAttribute("src"), location.href).href
      : new URL(embed.querySelector("source[src]")?.getAttribute("src") ?? "", location.href).href
    const note = embedNote(
      { tag: embed.localName, src, poster: embed.getAttribute("poster") ?? "" },
      location.href,
    )
    if (!note) continue
    const paragraph = document.createElement("p")
    const label = document.createElement("strong")
    label.textContent = `${note.label}: `
    const link = document.createElement("a")
    link.href = note.url
    link.textContent = note.text
    paragraph.append(label, link)
    embed.replaceWith(paragraph)
  }
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
  // Every picture in the document itself, sized to fit a page.
  for (const source of copy.querySelectorAll("picture > source")) source.remove()
  await Promise.all(
    images.map(async ([image, shownImage]) => {
      if (!copy.contains(image) || !image.getAttribute("src")) return
      const src = image.src
      const shown = box(shownImage)
      const max = pictureMax(image)
      image.removeAttribute("srcset")
      image.removeAttribute("loading")
      image.removeAttribute("decoding")
      try {
        setPicture(image, await docPicture(await fetchPicture(src), { shown, max }))
      } catch {
        // One the page can't read (another site's): Google fetches it, at the size it fits.
        const natural = shownImage?.naturalWidth
          ? { width: shownImage.naturalWidth, height: shownImage.naturalHeight }
          : null
        setPicture(image, { src, ...docImageSize({ natural, shown, max }) })
      }
    }),
  )
  // Tables span the page, their header row dark as on the site.
  for (const table of copy.querySelectorAll("table")) {
    table.setAttribute("border", "1")
    table.setAttribute("cellpadding", "6")
    table.setAttribute("cellspacing", "0")
    table.setAttribute("width", "100%")
    table.setAttribute("style", "border-collapse:collapse;width:100%")
    for (const cell of table.querySelectorAll("thead th"))
      cell.setAttribute("style", "background-color:#222222;color:#ffffff;font-weight:bold")
  }
  const styled = (node) =>
    ["img", "table"].includes(node.localName) || (node.localName === "th" && node.closest("thead"))
  for (const node of copy.querySelectorAll("*"))
    for (const name of node.getAttributeNames())
      if (name.startsWith("data-") || name === "class" || (name === "style" && !styled(node)))
        node.removeAttribute(name)
  return copy.innerHTML
}
