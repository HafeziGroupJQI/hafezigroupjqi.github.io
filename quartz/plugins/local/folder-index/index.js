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
//   - a listing of subfolders first, then pages A to Z, each page with its description and the date
//     of its newest revision in the vault's history (SITE_HISTORY, tools/history.mjs), never the
//     build's time.
// A page with an index of its own is rendered by Quartz's FolderContent exactly as before.
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

/** The folder a folder page is for: "resources/notes/index" is "resources/notes". */
export const folderOf = (slug) => String(slug).replace(/\/?index$/, "")

/** Quartz's virtual folder pages, retitled and marked as automatic. */
export function automaticPages(pages) {
  return pages.map((page) => {
    // A tag's folder (tags/role/) is the tag pages' own: left to Quartz as it was.
    if (page.slug.startsWith("tags/")) return page
    const title = folderTitle(page.title)
    return {
      slug: page.slug,
      title,
      data: {
        frontmatter: { title, tags: [], folder_index: AUTO, socialImage: SOCIAL_IMAGE },
      },
    }
  })
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

/**
 * A folder page's rows: its subfolders first, then its pages, each group A to Z by title. A row is
 * `{slug, title, folder, description, day, tags}`; only pages have a day, and only when the vault's
 * history has one.
 */
export function folderRows(slug, allFiles, histories = {}) {
  const prefix = folderOf(slug) + "/"
  const rows = []
  for (const file of allFiles ?? []) {
    if (!file?.slug || file.unlisted === true || !file.slug.startsWith(prefix)) continue
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
    })
  }
  return [
    ...rows.filter((row) => row.folder).sort(byTitle),
    ...rows.filter((row) => !row.folder).sort(byTitle),
  ]
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

function Listing({ fileData, allFiles, cfg }) {
  const slug = fileData.slug
  const rows = folderRows(slug, allFiles, siteHistory())
  const locale = cfg?.locale ?? "en-US"
  return h(
    "div",
    { class: "page-listing folder-listing" },
    rows.length > 0 &&
      h(
        "ul",
        { class: "section-ul" },
        rows.map((row) =>
          h(
            "li",
            { class: "section-li" },
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
                row.description &&
                  h("p", { class: "folder-listing__description" }, row.description),
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
      ),
    rows.length === 0 && h("p", null, "This folder has no pages yet."),
  )
}

export default (options) => {
  const quartz = QuartzFolderPage(options)
  return {
    ...quartz,
    generate(args) {
      return automaticPages(quartz.generate(args))
    },
    body() {
      const QuartzFolderContent = quartz.body()
      const FolderIndex = (props) => {
        if (props.fileData?.frontmatter?.folder_index !== AUTO) return QuartzFolderContent(props)
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
