import fs from "node:fs"
import { h, Fragment } from "preact"
import { FolderPage as QuartzFolderPage } from "@quartz-community/folder-page"
import { resolveRelative } from "@quartz-community/utils"
import { folderTitle } from "./names.js"

// Folder pages: Quartz's own folder page type (@quartz-community/folder-page 0.1.0, MIT,
// https://github.com/quartz-community/folder-page), which makes a page for every folder that holds
// a page and has no index of its own. This wrapper keeps its match, layout and page generation,
// and adds what the members site needs on those automatic pages:
//   - a readable title ("group-meeting-2026-09-29" is "Group meeting 2026-09-29");
//   - a page for a folder that holds only documents, from the build's folder map (SITE_FOLDERS,
//     tools/folder-files.mjs), so every folder of the private vault can be browsed;
//   - a listing of subfolders first, then pages A to Z, each page with its description and the date
//     of its newest revision in the vault's history (SITE_HISTORY, tools/history.mjs), never the
//     build's time; then the folder's documents as downloads;
//   - restricted pages, folders and documents (an access rule's, tools/acl/: `acl` in their front
//     matter or folder map entry) listed with data-acl="<rule>" when the folder page isn't that
//     rule's own, so the Worker shows them only to the members that rule lets in. They are unlisted,
//     so Quartz's own listings leave them out.
// A page with an index of its own is rendered by Quartz's FolderContent as before, its restricted
// rows of other rules after it, under data-acl.
// The rows' markup is Quartz's PageList's (same package, MIT), so the site's listing styles apply.
export const manifest = {
  name: "folder-index",
  displayName: "Folder index",
  description: "Quartz's folder pages with readable titles, real dates and the folder's files",
  version: "1.0.0",
  category: "pageType",
}

const AUTO = "auto"
// An automatic page has no social image of its own: the site's default, and none made for it.
const SOCIAL_IMAGE = "og-image.png"

const readJson = (file) => {
  try {
    return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}
  } catch {
    return {}
  }
}
const cached = (variable) => {
  let from
  let value = {}
  return () => {
    if (from !== process.env[variable]) {
      from = process.env[variable]
      value = readJson(from)
    }
    return value
  }
}
const siteHistory = cached("SITE_HISTORY")
const siteFolders = cached("SITE_FOLDERS")

/** A folder's entry in the build's folder map (tools/folder-files.mjs), by its slug. */
export const folderEntry = (folders, folder) => folders?.[folder] ?? null

/** The folder a folder page is for: "resources/notes/index" is "resources/notes". */
export const folderOf = (slug) => String(slug).replace(/\/?index$/, "")

/**
 * The automatic pages: Quartz's, retitled, and one for each folder of the folder map that holds no
 * page. `pages` are Quartz's virtual pages, `taken` the folders that already have an index.
 */
export function automaticPages(pages, taken = [], folders = {}) {
  const auto = (slug, title) => {
    const entry = folderEntry(folders, folderOf(slug))
    // A restricted folder's page is its rule's, unlisted like its pages.
    const acl = typeof entry?.acl === "string" ? entry.acl : null
    return {
      slug,
      title,
      data: {
        frontmatter: {
          title,
          tags: [],
          folder_index: AUTO,
          socialImage: SOCIAL_IMAGE,
          ...(entry?.path ? { folder_path: entry.path } : {}),
          ...(acl ? { acl, unlisted: true } : {}),
        },
        ...(acl ? { unlisted: true } : {}),
      },
    }
  }
  // A tag's folder (tags/role/) is the tag pages' own: left to Quartz as it was.
  const out = pages.map((page) =>
    page.slug.startsWith("tags/") ? page : auto(page.slug, folderTitle(page.title)),
  )
  const seen = new Set([...taken, ...pages.map((page) => folderOf(page.slug))])
  for (const [folder, entry] of Object.entries(folders).sort(([a], [b]) => a.localeCompare(b))) {
    if (seen.has(folder)) continue
    seen.add(folder)
    out.push(auto(`${folder}/index`, folderTitle(entry?.name ?? folder.split("/").pop())))
  }
  return out
}

/** The day a page last changed in its vault ("2026-09-29"), or null when its history doesn't say. */
export function modifiedDay(frontmatter, histories) {
  const { edit_repo: repo, edit_path: file } = frontmatter ?? {}
  if (typeof repo !== "string" || typeof file !== "string") return null
  const date = histories?.[`${repo}:${file}`]?.revisions?.[0]?.date
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null
}

const byTitle = (a, b) =>
  a.title.localeCompare(b.title, "en", { numeric: true, sensitivity: "base" }) ||
  a.slug.localeCompare(b.slug)

/** A page's access rule (tools/acl/), or null when it isn't restricted. */
export const aclOf = (frontmatter) =>
  typeof frontmatter?.acl === "string" && frontmatter.acl ? frontmatter.acl : null

/** The attributes that tag a listed item of another rule than the page listing it. */
export const aclAttributes = (acl, pageAcl) => (acl && acl !== pageAcl ? { "data-acl": acl } : {})

/**
 * A folder page's rows: its subfolders first, then its pages, each group A to Z by title. A row is
 * `{slug, title, folder, description, day, tags, acl}`; only pages have a day, and only when the
 * vault's history has one. A restricted page or folder (unlisted, with an access rule) is a row
 * with its rule as `acl`; any other unlisted page is left out.
 */
export function folderRows(slug, allFiles, histories = {}) {
  const prefix = folderOf(slug) + "/"
  const rows = []
  for (const file of allFiles ?? []) {
    if (!file?.slug || !file.slug.startsWith(prefix)) continue
    if (file.unlisted === true && !aclOf(file.frontmatter)) continue
    const rest = file.slug.slice(prefix.length)
    if (!rest || rest === "index") continue
    const parts = rest.split("/")
    const folder = parts.length === 2 && parts[1] === "index"
    if (parts.length !== 1 && !folder) continue
    const frontmatter = file.frontmatter ?? {}
    rows.push({
      slug: file.slug,
      title: String(frontmatter.title ?? parts[0]),
      folder,
      description:
        typeof frontmatter.description === "string" ? frontmatter.description.trim() : "",
      day: folder ? null : modifiedDay(frontmatter, histories),
      tags: folder ? [] : (frontmatter.tags ?? []).map(String),
      acl: aclOf(frontmatter),
    })
  }
  return [
    ...rows.filter((row) => row.folder).sort(byTitle),
    ...rows.filter((row) => !row.folder).sort(byTitle),
  ]
}

/** A size as people read it: 31.6 MB. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return ""
  if (bytes < 1000) return `${bytes} B`
  const units = ["kB", "MB", "GB"]
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value < 100 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

// The day as the author's calendar had it, whatever zone the build runs in.
function Day({ day, locale }) {
  const [year, month, date] = day.split("-").map(Number)
  const text = new Date(year, month - 1, date).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  })
  return h("time", { dateTime: day }, text)
}

function Rows({ slug, rows, locale, pageAcl }) {
  return h(
    "ul",
    { class: "section-ul" },
    rows.map((row) =>
      h(
        "li",
        { class: "section-li", ...aclAttributes(row.acl, pageAcl) },
        h(
          "div",
          { class: "section" },
          h(
            "p",
            { class: "meta" },
            row.folder ? "Folder" : row.day && h(Day, { day: row.day, locale }),
          ),
          h(
            "div",
            { class: "desc" },
            h(
              "h3",
              null,
              h("a", { href: resolveRelative(slug, row.slug), class: "internal" }, row.title),
            ),
            row.description && h("p", { class: "folder-listing__description" }, row.description),
          ),
          h(
            "ul",
            { class: "tags" },
            row.tags.map((tag) =>
              h(
                "li",
                null,
                h(
                  "a",
                  { class: "internal tag-link", href: resolveRelative(slug, `tags/${tag}`) },
                  tag,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )
}

function Listing({ fileData, allFiles, cfg }) {
  const slug = fileData.slug
  const pageAcl = aclOf(fileData.frontmatter)
  const rows = folderRows(slug, allFiles, siteHistory())
  const files = folderEntry(siteFolders(), folderOf(slug))?.files ?? []
  const locale = cfg?.locale ?? "en-US"
  return h(
    "div",
    { class: "page-listing folder-listing" },
    rows.length > 0 && h(Rows, { slug, rows, locale, pageAcl }),
    files.length > 0 &&
      h(
        Fragment,
        null,
        h("h2", { id: "files" }, "Files"),
        h(
          "ul",
          { class: "section-ul folder-files" },
          files.map((file) =>
            h(
              "li",
              { class: "section-li", ...aclAttributes(file.acl, pageAcl) },
              h(
                "div",
                { class: "section" },
                h(
                  "p",
                  { class: "meta" },
                  [file.type, formatSize(file.size)].filter(Boolean).join(", "),
                ),
                h(
                  "div",
                  { class: "desc" },
                  h(
                    "a",
                    { href: file.href, class: "internal", "data-no-popover": "true" },
                    file.name,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    rows.length === 0 && files.length === 0 && h("p", null, "This folder has no pages yet."),
  )
}

/**
 * Whether a folder holds restricted pages or folders (at any depth) of another rule than its own
 * page's: Quartz's listing of it would name their folders, so it is made without them.
 */
export function holdsOtherRules(slug, allFiles, pageAcl) {
  const prefix = folderOf(slug) + "/"
  return (allFiles ?? []).some((file) => {
    const acl = aclOf(file?.frontmatter)
    return acl && acl !== pageAcl && file.slug?.startsWith(prefix)
  })
}

// A page with an index of its own, holding restricted pages of other rules: Quartz's listing from
// its listed pages alone (its folder tree names every folder), then those rows, each rule's under
// its data-acl.
function RestrictedRows({ fileData, allFiles, cfg }) {
  const slug = fileData.slug
  const pageAcl = aclOf(fileData.frontmatter)
  const locale = cfg?.locale ?? "en-US"
  const byRule = new Map()
  for (const row of folderRows(slug, allFiles, siteHistory()))
    if (row.acl && row.acl !== pageAcl) byRule.set(row.acl, [...(byRule.get(row.acl) ?? []), row])
  return h(
    Fragment,
    null,
    [...byRule].map(([acl, rows]) =>
      h(
        "div",
        { class: "page-listing folder-listing", "data-acl": acl },
        h(Rows, { slug, rows, locale, pageAcl: acl }),
      ),
    ),
  )
}

export default (options) => {
  const quartz = QuartzFolderPage(options)
  return {
    ...quartz,
    generate(args) {
      const taken = args.content
        .map(([, file]) => file.data?.slug)
        .filter((slug) => typeof slug === "string" && slug.endsWith("/index"))
        .map(folderOf)
      // Only the members edition has a folder map; the public site's folders all have an index.
      return automaticPages(quartz.generate(args), taken, siteFolders())
    },
    body() {
      const QuartzFolderContent = quartz.body()
      const FolderIndex = (props) => {
        if (props.fileData?.frontmatter?.folder_index !== AUTO) {
          const pageAcl = aclOf(props.fileData?.frontmatter)
          if (!holdsOtherRules(props.fileData?.slug, props.allFiles, pageAcl))
            return QuartzFolderContent(props)
          // Without the folder tree, Quartz's FolderContent lists the folder's listed pages.
          const listed = { ...props, ctx: { ...props.ctx, trie: undefined } }
          return h(Fragment, null, QuartzFolderContent(listed), h(RestrictedRows, props))
        }
        // A page the build wrote for a section keeps its text; a virtual page has none.
        const own = props.fileData.filePath ? QuartzFolderContent(props) : null
        return h(Fragment, null, own, h(Listing, props))
      }
      return Object.assign(FolderIndex, {
        css: QuartzFolderContent.css,
        beforeDOMLoaded: QuartzFolderContent.beforeDOMLoaded,
        afterDOMLoaded: QuartzFolderContent.afterDOMLoaded,
      })
    },
  }
}
