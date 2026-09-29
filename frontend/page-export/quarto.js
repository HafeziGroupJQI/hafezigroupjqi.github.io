// A page's Markdown source as a Quarto document, for the Export menu's "Quarto (.qmd)". Pure (text
// in, text out), so node:test covers it. A notebook's .qmd comes from notebook-page/exporting.js.
//
// The front matter becomes Quarto's (the title, the author, date and description the page has, its
// tags as categories), as notebookToQmd writes a notebook's. The body keeps its Markdown, with the
// Obsidian syntax Quarto doesn't read in Pandoc's: callouts become callout blocks, wikilinks and
// embeds links and images, ==highlights== [marks]{.mark}, and %%comments%% go. Every link to the
// site gets its full URL, resolved as Quartz resolves it (crawl-links, markdownLinkResolution:
// shortest, with @quartz-community/utils' transformLink), so the file works away from the site.

import {
  simplifySlug,
  slugifyFilePath,
  stripSlashes,
  transformLink,
} from "@quartz-community/utils/path"
import { slug as headingSlug } from "github-slugger"

// ---- front matter ----

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** {front: the front matter's text or null, body}. */
export function splitFrontMatter(text) {
  const match = text.match(FRONT)
  return match
    ? { front: match[1], body: text.slice(match[0].length) }
    : { front: null, body: text }
}

/** The front matter's top-level entries, each {key, lines}, its value lines kept as written. */
export function frontEntries(front) {
  const entries = []
  for (const line of (front ?? "").split(/\r?\n/)) {
    const key = line.match(/^([A-Za-z_][\w-]*):/)?.[1]
    if (key) entries.push({ key, lines: [line] })
    else entries.at(-1)?.lines.push(line)
  }
  return entries
}

// Keys Quarto reads the way the site's pages mean them; the rest are Quartz's or the site's own.
const QUARTO_KEYS = new Set(["subtitle", "author", "authors", "date", "description", "abstract"])

/** A page's tags as Quarto categories, without the site's own "internal" marker. */
function categories(entry) {
  const lines = entry.lines
    .filter((line) => !/^\s*-\s*["']?internal["']?\s*$/.test(line))
    .map((line, index) => (index ? line : line.replace(/^tags:/, "categories:")))
  const [head, ...items] = lines
  if (/^categories:\s*(?:\[\s*\])?\s*$/.test(head) && !items.some((line) => line.trim())) return []
  return lines
}

export function qmdFrontMatter(front, title) {
  const entries = frontEntries(front)
  const titled = entries.find((entry) => entry.key === "title")
  const head = ["---", ...(title ? [`title: ${JSON.stringify(title)}`] : (titled?.lines ?? []))]
  for (const entry of entries) {
    if (QUARTO_KEYS.has(entry.key)) head.push(...entry.lines)
    if (entry.key === "tags") head.push(...categories(entry))
  }
  head.push("---")
  return head.join("\n")
}

// ---- links ----

/**
 * The full URL of a link written on the page `slug` of the site at `origin`: as crawl-links
 * resolves an internal link, then made absolute. `allSlugs` are the site's (its content index, and
 * the files the page shows). Absolute URLs and in-page anchors are returned as they are.
 */
export function siteUrl(target, { slug, origin, allSlugs }) {
  if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(target)) return target
  try {
    const relative = transformLink(slug, target, { strategy: "shortest", allSlugs })
    return new URL(relative, `${origin}/${stripSlashes(simplifySlug(slug), true)}`).href
  } catch {
    return target
  }
}

const IMAGE = /\.(?:jxl|png|jpe?g|gif|bmp|webp|svg)$/i
// An embed's alias is its alt text, a size (300 or 300x200), or both (alt|300), as Obsidian reads it.
const EMBED_SIZE = /^(?<alt>(?!^\d*x?\d*$).*?)?(\|?\s*?(?<width>\d+)(x(?<height>\d+))?)?$/

/** A wikilink's inside ("note#Heading|alias") as a Markdown link or image, as Quartz renders it. */
export function wikilink(inner, embedded, link) {
  const [target, ...rest] = inner.split(/\\?\|/)
  const alias = rest.join("|").trim() || undefined
  const [fp = "", ...anchorParts] = target.trim().split("#")
  const anchor = anchorParts.join("#").trim()
  if (embedded && IMAGE.test(fp)) {
    const { alt = "", width, height } = EMBED_SIZE.exec(alias ?? "")?.groups ?? {}
    const size = [width && `width="${width}px"`, height && `height="${height}px"`].filter(Boolean)
    return `![${alt}](${link(slugifyFilePath(fp))})${size.length ? `{${size.join(" ")}}` : ""}`
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(fp)) return `[${alias ?? fp}](${fp})`
  const hash = anchor ? `#${anchor.startsWith("^") ? anchor : headingSlug(anchor)}` : ""
  // Without an alias the link reads as the note's name, not its path (crawl-links' prettyLinks).
  const text = alias ?? (fp && anchor ? `${fp} > ${anchor}` : fp || anchor).split("/").pop()
  // An embedded note can't be pulled in here: it becomes a link to that note.
  return `[${text}](${link(fp + hash) || hash})`
}

// ---- body ----

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const CALLOUT = /^ {0,3}> ?\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/
const QUOTED = /^ {0,3}>/
// Obsidian's callout types, by the Quarto callout they read as (note: all the others).
const CALLOUT_TYPES = {
  tip: ["tip", "hint", "success", "check", "done"],
  warning: ["warning", "attention"],
  caution: ["caution", "failure", "fail", "missing", "danger", "error", "bug"],
  important: ["important"],
}
const calloutType = (type) =>
  Object.keys(CALLOUT_TYPES).find((quarto) => CALLOUT_TYPES[quarto].includes(type)) ?? "note"
const attribute = (text) => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')

function callout(lines, context) {
  const [, rawType, fold, rawTitle] = lines[0].match(CALLOUT)
  const type = rawType.toLowerCase()
  const quarto = calloutType(type)
  // A type Quarto has no block for keeps its name as the title, as Obsidian shows it.
  const title =
    rawTitle.trim().replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2") ||
    (type === quarto ? "" : type[0].toUpperCase() + type.slice(1))
  const attributes = [`.callout-${quarto}`]
  if (title) attributes.push(`title="${attribute(title)}"`)
  if (fold) attributes.push(`collapse="${fold === "-"}"`)
  const inner = lines.slice(1).map((line) => line.replace(/^ {0,3}> ?/, ""))
  return [`::: {${attributes.join(" ")}}`, convertBody(inner.join("\n"), context), ":::"].join("\n")
}

// Inline code keeps its text: swapped out while the rest is converted.
function withoutCode(text, convert) {
  const spans = []
  const masked = text.replace(/(`+)[\s\S]*?\1/g, (span) => `\u0000${spans.push(span) - 1}\u0000`)
  return convert(masked).replace(/\u0000(\d+)\u0000/g, (_, index) => spans[index])
}

function convertProse(text, context) {
  const link = (target) => siteUrl(target, context)
  return withoutCode(text, (prose) =>
    prose
      .replace(/%%[\s\S]*?%%/g, "")
      .replace(/(!?)\[\[([^\]\n]+?)\]\]/g, (_, bang, inner) => wikilink(inner, !!bang, link))
      .replace(/==(?=\S)([^\n]*?\S)==/g, "[$1]{.mark}")
      .replace(/\]\(\s*(<[^>\n]*>|[^)\s]+)((?:\s+"[^"\n]*")?)\s*\)/g, (_, target, title) =>
        target.startsWith("<")
          ? `](<${link(target.slice(1, -1))}>${title})`
          : `](${link(target)}${title})`,
      )
      .replace(/\b((?:href|src)=")([^"\n]+)"/g, (_, prefix, target) => `${prefix}${link(target)}"`),
  )
}

/** The body's Markdown with Obsidian's syntax in Pandoc's; code blocks are left as they are. */
export function convertBody(text, context) {
  const lines = text.split("\n")
  const out = []
  let prose = []
  const flush = () => {
    if (prose.length) out.push(convertProse(prose.join("\n"), context))
    prose = []
  }
  for (let index = 0; index < lines.length; index++) {
    const fence = lines[index].match(FENCE)
    if (fence) {
      flush()
      const marker = fence[1]
      let end = index + 1
      while (
        end < lines.length &&
        !new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(
          lines[end],
        )
      )
        end++
      out.push(lines.slice(index, end + 1).join("\n"))
      index = end
      continue
    }
    if (CALLOUT.test(lines[index])) {
      flush()
      let end = index + 1
      while (end < lines.length && QUOTED.test(lines[end])) end++
      out.push(callout(lines.slice(index, end), context))
      index = end - 1
      continue
    }
    prose.push(lines[index])
  }
  flush()
  return out.join("\n")
}

/**
 * A page's Markdown source as a .qmd. context: {title (the page's), slug (its Quartz slug), origin
 * (the site's), allSlugs (for links, see siteUrl)}.
 */
export function markdownToQmd(markdown, context) {
  const { front, body } = splitFrontMatter(markdown.replace(/^\uFEFF/, ""))
  // A path listed twice would be two matches, which shortest-path resolution takes for none.
  const links = { ...context, allSlugs: [...new Set(context.allSlugs)] }
  return `${qmdFrontMatter(front, context.title)}\n\n${convertBody(body, links).trim()}\n`
}
