// The editor kit's page links (index.js): which of the site's pages a link can name, how each vault
// writes a link to one, and which match what is typed, best first. Pure, so it runs under node.
//
// The site's pages come from its content index (Quartz's static/contentIndex.json, the page's
// `fetchData`): {slug, filePath, title, …} per page, the private vault's under resources/. A
// link is written where it is read:
//   "site"           an announcement, read on the members site: any page, by its path on the site
//                    ([[resources/notes/x|…]], [[people/y|…]]).
//   "vault"          a page of the public vault: its own pages only (the public site has no
//                    resources/), by their path in the vault, which is their path on the site.
//   "vault-private"  a page of the private vault: its pages by their path in that vault, as it
//                    writes them ([[notes/x|…]], which tools/prepare-unified.mjs privateLink and
//                    the editor's preview resolve from the vault's top); a public page as a
//                    site-absolute Markdown link ([…](/people/y)), since the vault's check reads a
//                    wikilink as one of its own files.

/** The member tool pages: in the index, but not pages anyone links to from a note. */
export const APP_PAGES = new Set([
  "404",
  "admin",
  "announcements",
  "calendar",
  "device",
  "devices",
  "edit",
  "experiment-builder",
  "experiments",
  "gpt",
  "instrument",
  "leaderboard",
  "recent",
  "scratchpad",
  "settings",
  "uploads",
])

export const MODES = ["site", "vault", "vault-private"]
export const MAX_OPTIONS = 30

/** The index's pages a link can name: no tag listings and no member tools. */
export function pageEntries(index) {
  const out = []
  for (const [key, page] of Object.entries(index ?? {})) {
    const slug = String(page?.slug ?? key)
    if (!slug || slug.startsWith("tags/") || APP_PAGES.has(slug)) continue
    const filePath = String(page?.filePath ?? `${slug}.md`)
    out.push({
      slug,
      filePath,
      title: String(page?.title || slug.split("/").pop()),
      private: slug.startsWith("resources/") || filePath.startsWith("resources/"),
    })
  }
  return out
}

const withoutExt = (file) => file.replace(/\.md$/i, "")
/** A page's address on the site: a folder's index as the folder. */
export const siteHref = (slug) => "/" + slug.replace(/(^|\/)index$/, "$1")

// A link's text: no brackets or pipes to end it early.
const aliasText = (title) =>
  title
    .replace(/[[\]|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
const linkText = (title) => title.replace(/([[\]\\])/g, "\\$1")

/**
 * How a page is linked from a document of `mode`: `wiki` is the inside of a [[wikilink]] (null:
 * this page isn't linked by one there, `markdown` is the Markdown link to use instead), `href` the
 * target after `](` (null: not offered there). null when the page can't be linked from it at all.
 */
export function linkFor(entry, mode) {
  if (mode === "vault") {
    if (entry.private) return null
    return { wiki: withoutExt(entry.filePath), href: siteHref(entry.slug) }
  }
  if (mode === "vault-private") {
    if (!entry.private)
      return {
        wiki: null,
        markdown: `[${linkText(entry.title)}](${siteHref(entry.slug)})`,
        href: siteHref(entry.slug),
      }
    return { wiki: withoutExt(entry.filePath.replace(/^resources\//, "")), href: null }
  }
  return { wiki: withoutExt(entry.filePath), href: siteHref(entry.slug) }
}

/** What a wikilink to `entry` inserts: [[path|Title]]. */
export const wikilinkText = (wiki, title) => {
  const alias = aliasText(title)
  return alias && alias !== wiki ? `[[${wiki}|${alias}]]` : `[[${wiki}]]`
}

/**
 * What the text before the cursor is completing: a wikilink after `[[` (or `![[`), or a link's
 * target after `](`, with what is typed so far and where it starts (`from`, an offset in `before`).
 * null when neither. A target that is already a web address (has a colon) is left alone.
 */
export function completionQuery(before) {
  const wiki = before.match(/(!?)\[\[([^[\]|#\n]*)$/)
  if (wiki)
    return {
      kind: "wiki",
      embed: wiki[1] === "!",
      query: wiki[2],
      start: before.length - wiki[0].length,
      from: before.length - wiki[2].length,
    }
  const link = before.match(/\]\(([^()\s]*)$/)
  if (link && !link[1].includes(":"))
    return {
      kind: "link",
      embed: false,
      query: link[1],
      start: null,
      from: before.length - link[1].length,
    }
  return null
}

// ---- ranking ----

const norm = (text) => text.toLowerCase().replace(/[-_/]+/g, " ")

/** How far apart `query`'s letters are in `text` (a subsequence), or -1 when they aren't all there. */
function spread(query, text) {
  let at = -1
  let gaps = 0
  for (const ch of query) {
    if (ch === " ") continue
    const next = text.indexOf(ch, at + 1)
    if (next < 0) return -1
    if (at >= 0) gaps += next - at - 1
    at = next
  }
  return gaps
}

/** How well `entry` matches `query` (higher is better), 0 when it doesn't. */
export function matchScore(entry, query, path = entry.slug) {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const title = entry.title.toLowerCase()
  const p = path.toLowerCase()
  const name = p.split("/").pop()
  if (title === q || name === q) return 1000
  if (title.startsWith(q)) return 900 - Math.min(title.length, 100)
  if (name.startsWith(q)) return 800 - Math.min(name.length, 100)
  const words = norm(title).split(/\s+/)
  if (words.some((word) => word.startsWith(q))) return 700
  if (title.includes(q)) return 600
  if (p.startsWith(q)) return 550
  if (p.includes(q)) return 500
  const tokens = norm(q).split(/\s+/).filter(Boolean)
  const haystack = `${norm(title)} ${norm(p)}`
  if (tokens.length > 1 && tokens.every((token) => haystack.includes(token))) return 400
  const inTitle = spread(q, title)
  if (inTitle >= 0) return Math.max(100, 300 - inTitle * 10)
  const inPath = spread(q, p)
  if (inPath >= 0) return Math.max(10, 200 - inPath * 10)
  return 0
}

/**
 * The pages to offer for what is typed after `[[` or `](` in a document of `mode`, best first, at
 * most MAX_OPTIONS: [{entry, link, score}].
 */
export function rankPages(entries, query, { mode = "site", kind = "wiki", embed = false } = {}) {
  const out = []
  for (const entry of entries) {
    const link = linkFor(entry, mode)
    if (!link) continue
    if (kind === "link" && !link.href) continue
    // An embed (![[…]]) pulls in a file of the vault: a Markdown link can't stand in for it.
    if (kind === "wiki" && embed && !link.wiki) continue
    const score = matchScore(entry, query, link.wiki ?? entry.slug)
    if (score > 0) out.push({ entry, link, score })
  }
  out.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.title.length - b.entry.title.length ||
      a.entry.title.localeCompare(b.entry.title),
  )
  return out.slice(0, MAX_OPTIONS)
}
