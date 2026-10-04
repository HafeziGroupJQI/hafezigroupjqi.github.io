// An announcement's Markdown as HTML, by the page editor's renderer (frontend/edit/preview.js):
// GitHub Markdown, [[wikilinks]] to the site's pages, callouts, KaTeX, all sanitized. Its links
// are the site's paths (the editor kit's "site" links), resolved as Quartz resolves them.
import { renderPreview } from "../edit/preview.js"

/* global fetchData */

let slugs = null
const siteSlugs = () =>
  (slugs ??=
    typeof fetchData === "undefined"
      ? Promise.resolve([])
      : fetchData.then((index) => Object.keys(index ?? {})).catch(() => []))

/** The HTML of an announcement's text: sanitized, safe to set as innerHTML. */
export async function renderAnnouncement(markdown) {
  // The renderer reads a page's front matter: a leading line break keeps a --- rule as one.
  const { html } = renderPreview("\n" + markdown, {
    kind: "md",
    repo: "site",
    path: "",
    slug: "announcements",
    allSlugs: await siteSlugs(),
    origin: location.origin,
  })
  return html
}
