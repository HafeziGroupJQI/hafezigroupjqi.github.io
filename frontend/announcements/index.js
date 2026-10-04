// /announcements: every live announcement, newest first, for every member; for admins also the
// drafts and scheduled ones, each with its status, and the composer (composer.js, loaded for
// admins only) to write, schedule, change and delete them. The Worker's src/announcements.ts.

import { h, present } from "../dashboard/dom.js"
import { statusOf, statusText } from "./model.js"
import { bodyElement, filesList, metaLine } from "./view.js"

const anchor = (announcement) => `announcement-${announcement.id}`

export function mountAnnouncements(root, { api }) {
  const notice = h("p", { class: "dash-error", role: "alert", hidden: true })
  const composerHost = h("div", { class: "announcement-composer-host" })
  const pendingList = h("section", { class: "announcement-admin", hidden: true })
  const archive = h("section", { class: "announcement-archive", "aria-label": "Announcements" })
  root.replaceChildren(
    h("h1", { class: "dash-title", text: "Announcements" }),
    h("p", {
      class: "muted",
      text: "News for the group. A new one opens over the site once for each member, until they dismiss it.",
    }),
    notice,
    composerHost,
    pendingList,
    archive,
  )

  let composer = null
  const say = (text) => {
    notice.hidden = !text
    notice.textContent = text ?? ""
  }

  async function remove(announcement) {
    const name = announcement.title || "this untitled draft"
    if (!confirm(`Delete “${name}” and its attachments? Members can't see it after this.`)) return
    try {
      await api(`/api/announcements/${encodeURIComponent(announcement.id)}`, { method: "DELETE" })
      if (composer?.editing() === announcement.id) composer.edit(null)
      await load()
    } catch (error) {
      say(error.message)
    }
  }

  const adminButtons = (announcement) =>
    h(
      "div",
      { class: "announcement-admin-actions" },
      h("button", {
        type: "button",
        text: "Edit",
        "aria-label": `Edit ${announcement.title || "untitled draft"}`,
        onclick: () => composer?.edit(announcement),
      }),
      h("button", {
        type: "button",
        class: "danger",
        text: "Delete",
        "aria-label": `Delete ${announcement.title || "untitled draft"}`,
        onclick: () => remove(announcement),
      }),
    )

  function article(announcement, isAdmin) {
    return h(
      "article",
      { class: "announcement-card", id: anchor(announcement) },
      h(
        "header",
        { class: "announcement-card__head" },
        // Under the admins' "Live" heading, a level down.
        h(
          isAdmin ? "h3" : "h2",
          {},
          h("a", { href: `#${anchor(announcement)}`, text: announcement.title || "(untitled)" }),
        ),
        isAdmin
          ? h("span", {
              class: `status status-${statusOf(announcement)}`,
              text: statusText(announcement),
            })
          : null,
      ),
      metaLine(announcement),
      bodyElement(announcement),
      filesList(announcement.files),
      isAdmin ? adminButtons(announcement) : null,
    )
  }

  async function load() {
    const data = await api("/api/announcements")
    const now = Date.now()
    const live = data.announcements.filter((a) => statusOf(a, now) === "live")
    const waiting = data.announcements.filter((a) => statusOf(a, now) !== "live")
    if (data.is_admin && !composer) {
      composerHost.replaceChildren(h("p", { class: "muted", text: "Loading the composer…" }))
      composer = await import("./composer.js").then(({ createComposer }) =>
        createComposer(composerHost, { api, onSaved: load }),
      )
    }
    pendingList.hidden = !data.is_admin
    if (data.is_admin)
      pendingList.replaceChildren(
        h("h2", { text: "Drafts and scheduled" }),
        waiting.length
          ? h(
              "ul",
              { class: "announcement-status-list" },
              waiting.map((a) =>
                h(
                  "li",
                  {},
                  h("strong", { text: a.title || "(untitled)" }),
                  h("span", {
                    class: `status status-${statusOf(a, now)}`,
                    text: statusText(a, now),
                  }),
                  adminButtons(a),
                ),
              ),
            )
          : h("p", { class: "muted", text: "None: every announcement is live." }),
      )
    archive.replaceChildren(
      ...present(
        data.is_admin ? h("h2", { text: "Live" }) : null,
        live.length
          ? live.map((a) => article(a, data.is_admin))
          : h("p", { class: "muted", text: "No announcements yet." }),
      ),
    )
    // A link to one (#announcement-<id>) lands on it once it is there.
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView()
  }

  load().catch((error) => say(error.message))
}
