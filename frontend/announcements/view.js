// The parts of an announcement the spotlight (modal.js) and the page (index.js) both show.
import { h } from "../dashboard/dom.js"
import { dateLabel, sizeLabel } from "./model.js"
import { renderAnnouncement } from "./render.js"

/** Who posted it and when it went live (or was last saved, for a draft). */
export function metaLine(announcement) {
  const author = announcement.author ?? { name: announcement.created_by }
  const at = announcement.publish_at ?? announcement.updated_at
  return h(
    "p",
    { class: "announcement-meta" },
    author.page
      ? h("a", { href: author.page, text: author.name })
      : h("span", { text: author.name }),
    " · ",
    h("time", { datetime: new Date(at).toISOString(), text: dateLabel(at) }),
  )
}

/** Its text, rendered and sanitized (render.js). */
export function bodyElement(announcement, id) {
  const body = h("div", { class: "announcement-body text-content", id })
  if (!announcement.body_md?.trim()) return body
  body.append(h("p", { class: "muted", text: "Loading…" }))
  renderAnnouncement(announcement.body_md)
    .then((html) => {
      // Sanitized by the renderer (rehype-sanitize) before KaTeX.
      body.innerHTML = html
    })
    .catch((error) => {
      console.error(error)
      body.replaceChildren(h("pre", { class: "announcement-raw", text: announcement.body_md }))
    })
  return body
}

/** Its attachments, as links (images and PDFs open, other files download). */
export function filesList(files = []) {
  if (!files.length) return null
  return h(
    "ul",
    { class: "announcement-files", "aria-label": "Attachments" },
    files.map((file) =>
      h(
        "li",
        {},
        h("a", { href: file.url, target: "_blank", rel: "noopener", text: file.name }),
        h("span", { class: "muted", text: ` ${sizeLabel(file.size)}` }),
      ),
    ),
  )
}
