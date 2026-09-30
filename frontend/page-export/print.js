// Printing a page: Ctrl+P, Print… in its Export menu, and the PDF the build prints of it in
// headless Chromium (tools/render-pdfs.mjs). The print stylesheet (quartz/styles/print.scss) lays
// the article out in the site's own type and colours; this readies the page for it first, and
// undoes it after:
//   - each external link gets a bracketed number, and the addresses are listed at the end under
//     "Links": one number per address, none where the link's text is its address;
//   - embeds (iframes, videos, sounds) become a boxed note with their address, and a YouTube video
//     its thumbnail;
//   - code blocks widen their line-number gutter to their largest number, and short ones are kept
//     on one page;
//   - folded sections and callouts open, lazy images load, and the light theme is set;
//   - fit(): tables and display equations wider than the paper are zoomed down to fit it, and a
//     table still too wide at the smallest zoom gets the screen's even columns.
// The build calls window.hafeziPrint's prepare(), then fit() under print media, then prints.

/** The column's width in CSS px inside the page margins (print.scss's @page): Letter and A4. */
export const PAPER_WIDTH = { letter: 688, a4: 665 }
/** Code blocks of at most this many lines are never split across pages. */
export const KEEP_LINES = 12
/** Tables and equations are zoomed down to at most these, then tables get even columns. */
export const FLOOR = { table: 0.6, equation: 0.5 }

// ---- pure helpers (node:test) ----

const bare = (value) =>
  value
    .trim()
    .replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "")

const decoded = (value, decode = decodeURI) => {
  try {
    return decode(value)
  } catch {
    return value
  }
}

/**
 * Which links get a numbered note: links [{href, text}] on the page at `page` → {refs, notes},
 * where refs[i] is link i's number (or null) and notes lists the addresses in number order. A
 * link to another site gets one, unless its text is its address (without the scheme, www. or a
 * trailing slash); the same address (with or without a trailing slash) gets the same number. An
 * email link gets one when its text isn't the address. Links within the site (pages, anchors,
 * tags) and javascript:, blob: or data: ones get none: in the PDF they stay clickable, and their
 * text says where they go.
 */
export function linkNotes(links, page) {
  const here = new URL(page)
  const notes = []
  const numbers = new Map()
  const refs = links.map(({ href, text = "" }) => {
    let url
    try {
      url = new URL(href, page)
    } catch {
      return null
    }
    let shown
    if (url.protocol === "mailto:") {
      shown = decoded(url.pathname, decodeURIComponent)
      if (bare(text).toLowerCase() === shown.toLowerCase()) return null
    } else if (url.protocol === "http:" || url.protocol === "https:") {
      if (url.origin === here.origin) return null
      shown = url.href
      if ([url.href, decoded(url.href)].some((value) => bare(value) === bare(text))) return null
    } else return null
    // An address with or without its trailing slash is one address.
    const key = shown.replace(/\/+$/, "")
    if (!numbers.has(key)) {
      notes.push(shown)
      numbers.set(key, notes.length)
    }
    return numbers.get(key)
  })
  return { refs, notes }
}

/**
 * The note an embed prints as: {label, url, text, image?, hint?} for an iframe, video or audio
 * ({tag, src, poster}) on the page at `page`, or null for one with no address to give.
 */
export function embedNote({ tag, src = "", poster = "" }, page) {
  let url
  try {
    url = new URL(src, page)
  } catch {
    return null
  }
  if (!src || !["http:", "https:"].includes(url.protocol)) return null
  const shown = decoded(url.href.replace(/^https?:\/\//, ""))
  const youtube =
    url.href.match(
      /(?:youtube(?:-nocookie)?\.com\/(?:embed|shorts|live|v)\/|youtu\.be\/)([\w-]{6,})/,
    )?.[1] ??
    (/(^|\.)youtube\.com$/.test(url.hostname) && url.pathname === "/watch"
      ? url.searchParams.get("v")
      : null)
  if (youtube) {
    const watch = `https://www.youtube.com/watch?v=${youtube}`
    return {
      label: "Video",
      url: watch,
      text: watch.replace(/^https:\/\//, ""),
      image: `https://i.ytimg.com/vi/${youtube}/hqdefault.jpg`,
    }
  }
  const vimeo = url.href.match(/player\.vimeo\.com\/video\/(\d+)/)?.[1]
  if (vimeo)
    return { label: "Video", url: `https://vimeo.com/${vimeo}`, text: `vimeo.com/${vimeo}` }
  const name = decoded(url.pathname.split("/").pop() || url.host)
  if (tag === "video") {
    let image = null
    try {
      image = poster ? new URL(poster, page).href : null
    } catch {
      image = null
    }
    return { label: "Video", url: url.href, text: name, image }
  }
  if (tag === "audio") return { label: "Audio", url: url.href, text: name }
  if (/\.pdf$/i.test(url.pathname))
    return {
      label: "Embedded PDF",
      url: url.href,
      text: name,
      hint: "open it from the online page",
    }
  return { label: "Embedded page", url: url.href, text: shown }
}

/** A code block's gutter width in digits: its line count's, from 10 lines on (else the default). */
export const gutterDigits = (lines) => (lines >= 10 ? String(lines).length : null)

/** The zoom that fits `natural` px into `available`, with 2% to spare, never below `floor`. */
export function fitZoom(natural, available, floor = FLOOR.table) {
  if (!(natural > available) || !(available > 0)) return 1
  return Math.max(floor, Math.floor((available / natural) * 0.98 * 100) / 100)
}

// ---- the page ----

let undo = []
let prepared = null

const element = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
  node.append(...children)
  return node
}

const link = (href, text) => element("a", { href }, text)

/**
 * Ready the article for printing, synchronously (a beforeprint handler can't wait): what the list
 * at the top says, except loading. Returns {notes, embeds}; undone by cleanup().
 */
export function prepareSync() {
  if (prepared) return prepared
  const article = document.querySelector(".page-body")
  prepared = { notes: 0, embeds: 0 }
  if (!article) return prepared
  const later = (step) => undo.push(step)

  // The light theme: paper is light, whatever the screen's.
  const root = document.documentElement
  const theme = root.getAttribute("saved-theme")
  if (theme && theme !== "light") {
    root.setAttribute("saved-theme", "light")
    later(() => root.setAttribute("saved-theme", theme))
  }

  // Folded sections and callouts open.
  for (const details of article.querySelectorAll("details:not([open])")) {
    details.open = true
    later(() => (details.open = false))
  }
  for (const callout of article.querySelectorAll(".callout.is-collapsed")) {
    const content = callout.querySelector(":scope > .callout-content")
    const rows = content?.style.gridTemplateRows ?? ""
    callout.classList.remove("is-collapsed")
    if (content) content.style.gridTemplateRows = "1fr"
    later(() => {
      callout.classList.add("is-collapsed")
      if (content) content.style.gridTemplateRows = rows
    })
  }

  // Code: the gutter fits the largest line number; short blocks stay whole.
  for (const code of article.querySelectorAll("pre > code")) {
    const lines = code.querySelectorAll(":scope > [data-line]").length
    const digits = gutterDigits(lines)
    if (digits && !code.hasAttribute("data-line-numbers-max-digits")) {
      code.setAttribute("data-line-numbers-max-digits", String(digits))
      later(() => code.removeAttribute("data-line-numbers-max-digits"))
    }
    const pre = code.parentElement
    if ((lines || code.textContent.split("\n").length) <= KEEP_LINES) {
      pre.classList.add("print-keep")
      later(() => pre.classList.remove("print-keep"))
    }
  }

  // External links: numbered, and listed at the end.
  const anchors = [...article.querySelectorAll("a[href]")].filter(
    (anchor) => !anchor.classList.contains("tag-link"),
  )
  const { refs, notes } = linkNotes(
    anchors.map((anchor) => ({ href: anchor.href, text: anchor.textContent })),
    location.href,
  )
  anchors.forEach((anchor, index) => {
    if (!refs[index]) return
    const ref = element("sup", { class: "print-ref" }, `[${refs[index]}]`)
    anchor.after(ref)
    later(() => ref.remove())
  })
  if (notes.length) {
    const list = element(
      "section",
      { class: "print-links" },
      element("h2", {}, "Links"),
      element(
        "ol",
        {},
        ...notes.map((note) =>
          element("li", {}, link(/^[a-z][a-z\d+.-]*:/i.test(note) ? note : `mailto:${note}`, note)),
        ),
      ),
    )
    article.append(list)
    later(() => list.remove())
  }
  prepared.notes = notes.length

  // Embeds: a note with the address in their place.
  for (const embed of article.querySelectorAll("iframe, video, audio")) {
    const src = embed.getAttribute("src")
      ? embed.src
      : (embed.querySelector("source[src]")?.src ?? "")
    const note = embedNote(
      { tag: embed.localName, src, poster: embed.getAttribute("poster") ?? "" },
      location.href,
    )
    const box = element(
      "div",
      { class: "print-embed" },
      ...(note
        ? [
            ...(note.image ? [element("img", { src: note.image, alt: "" })] : []),
            element("strong", {}, `${note.label}: `),
            link(note.url, note.text),
            ...(note.hint ? [` (${note.hint})`] : []),
          ]
        : [element("strong", {}, "Embedded content"), " (see the online page)"]),
    )
    embed.classList.add("print-replaced")
    embed.after(box)
    later(() => {
      box.remove()
      embed.classList.remove("print-replaced")
    })
    prepared.embeds++
  }

  // A drawing on a canvas prints as its picture, when the page may read it.
  for (const canvas of article.querySelectorAll("canvas")) {
    let src
    try {
      src = canvas.toDataURL("image/png")
    } catch {
      continue
    }
    const picture = element("img", { src, alt: "", width: String(canvas.clientWidth) })
    canvas.classList.add("print-replaced")
    canvas.after(picture)
    later(() => {
      picture.remove()
      canvas.classList.remove("print-replaced")
    })
  }

  // Lazy images load now, not after the page is captured.
  for (const image of article.querySelectorAll('img[loading="lazy"]')) {
    image.loading = "eager"
    later(() => (image.loading = "lazy"))
  }
  return prepared
}

const settle = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))])

// Mermaid draws its diagrams after the page loads (from its CDN), in a scratch element first: wait
// for each finished picture, the diagram's own <svg viewBox>.
const undrawn = () =>
  [...document.querySelectorAll(".page-body code.mermaid")].filter(
    (code) => !code.querySelector(":scope > svg[viewBox]"),
  ).length
async function drawings(ms) {
  const until = Date.now() + ms
  while (undrawn() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100))
}

/**
 * prepareSync(), then wait (at most `timeout` ms) for what printing needs loaded: fonts, Mermaid's
 * drawings and every image in the article. Returns {notes, embeds, images, broken (images that
 * didn't load), undrawn (diagrams Mermaid didn't draw)}.
 */
export async function prepare({ timeout = 15_000 } = {}) {
  const summary = prepareSync()
  const images = [...document.querySelectorAll(".page-body img")]
  await settle(
    (async () => {
      await document.fonts?.ready
      await drawings(Math.min(timeout, 8000))
      await Promise.all(
        images.map((image) =>
          image.complete && image.naturalWidth ? null : image.decode().catch(() => null),
        ),
      )
      await document.fonts?.ready
    })(),
    timeout,
  )
  return {
    ...summary,
    images: images.length,
    broken: images.filter((image) => !(image.complete && image.naturalWidth)).length,
    undrawn: undrawn(),
  }
}

// Each table and display equation wider than the column, zoomed to fit it (.print-fit), in up to
// four passes (a zoomed table reflows); a table still too wide gets even columns (.print-squeeze).
function fitWide(article) {
  const report = []
  const zoom = (node, value) => {
    node.classList.add("print-fit")
    node.style.setProperty("--print-fit", String(value))
  }
  const measures = [
    ...[...article.querySelectorAll("table")].map((node) => ({
      node,
      floor: FLOOR.table,
      size: () => [
        node.getBoundingClientRect().width,
        (node.parentElement ?? article).getBoundingClientRect().width,
      ],
    })),
    ...[...article.querySelectorAll(".katex-display")].map((node) => ({
      node,
      floor: FLOOR.equation,
      size: () => [node.scrollWidth, node.clientWidth],
    })),
  ]
  for (const { node, floor, size } of measures) {
    if (!node.getClientRects().length) continue
    let [natural, available] = size()
    if (natural <= available + 1) continue
    const [before, column] = [natural, available]
    const style = node.getAttribute("style")
    undo.push(() => {
      node.classList.remove("print-fit", "print-squeeze")
      if (style === null) node.removeAttribute("style")
      else node.setAttribute("style", style)
    })
    let value = 1
    for (let pass = 0; pass < 4 && natural > available + 1 && value > floor; pass++) {
      value = Math.max(floor, Math.floor(value * fitZoom(natural, available, 0) * 100) / 100)
      zoom(node, value)
      ;[natural, available] = size()
    }
    let squeezed = false
    if (natural > available + 1 && node.localName === "table") {
      node.classList.add("print-squeeze")
      squeezed = true
      ;[natural, available] = size()
    }
    report.push({
      element: node.localName === "table" ? "table" : "equation",
      width: Math.round(before),
      column: Math.round(column),
      zoom: value,
      squeezed,
      fits: natural <= available + 1,
    })
  }
  return report
}

/**
 * Zoom what is too wide for paper `width` (CSS px inside the margins; the build passes Letter's)
 * to fit, laid out as it prints: under print media when the page is in it (the build), else in a
 * measuring pass on screen that applies the print stylesheet for a moment, synchronously, so
 * nothing is painted. Returns {fitted: [...], overflow: [...]}, overflow being what still runs
 * past the column.
 */
export function fit({ width = PAPER_WIDTH.a4 } = {}) {
  const article = document.querySelector(".page-body")
  if (!article) return { fitted: [], overflow: [] }
  const root = document.documentElement
  root.style.setProperty("--print-measure-width", `${width}px`)
  root.classList.add("print-measure")
  try {
    const fitted = fitWide(article)
    const edge = article.getBoundingClientRect().right + 1
    const overflow = [...article.querySelectorAll("*")]
      .filter((node) => node.getClientRects().length && node.getBoundingClientRect().right > edge)
      .filter((node) => !node.parentElement?.closest(".print-fit"))
      .map((node) =>
        `${node.localName}${node.classList.length ? "." + [...node.classList].join(".") : ""}`.slice(
          0,
          80,
        ),
      )
    return { fitted, overflow: [...new Set(overflow)] }
  } finally {
    root.classList.remove("print-measure")
    root.style.removeProperty("--print-measure-width")
  }
}

/** Undo prepareSync() and fit(). */
export function cleanup() {
  for (const step of undo.reverse()) step()
  undo = []
  prepared = null
}

/** Ctrl+P: ready the page as it starts printing (unless Print… already has), and undo it after. */
export function installPrint() {
  addEventListener("beforeprint", () => {
    if (prepared) return
    prepareSync()
    fit()
  })
  addEventListener("afterprint", cleanup)
}
