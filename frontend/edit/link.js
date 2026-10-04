// A page's Edit button, in its tools row (JqiFrame's [data-page-tools], whose data-edit-* name the
// page's own file in its vault, tools/prepare-site.mjs, prepare-unified.mjs, tools/notebooks/): it
// opens that file in the site's editor (/edit, index.js), a Quarto page's .qmd and a notebook
// page's .ipynb, never the page the site made from them. A Wolfram notebook is edited in the
// Scratchpad, the lab's Wolfram notebook editor. Small and without dependencies: it is on every
// member page (member-tools.js).

import { h } from "../dashboard/dom.js"
import { forkUrl } from "../scratchpad/launch.js"

/** The editor's address for a file, and the page it was opened from. */
export function editUrl({ repo, path, page = null, sha = null, note = null }) {
  const params = new URLSearchParams({ repo, path })
  if (page) params.set("page", page)
  if (sha) params.set("sha", sha)
  if (note) params.set("note", note)
  return `/edit?${params}`
}

/** A People page's file in the public vault (worker/src/profile/vault.ts PEOPLE_PAGE). */
const PEOPLE_PAGE = /^content\/people\/(?:alumni\/)?[a-z0-9]+(?:-[a-z0-9]+)*\.md$/

/** Whether only an admin may open a file in the editor: a People page (members change their own
 *  from Settings; the Worker refuses anyone else, worker/src/edit/rules.ts). */
export const adminOnly = (repo, path) =>
  repo === "vault" && PEOPLE_PAGE.test(path) && !path.endsWith("/index.md")

/**
 * What a page's Edit does, from its tools row's data: open the editor, the Scratchpad, or nothing
 * (a file that is replaced whole, or a People page for anyone but an admin).
 */
export function editAction(dataset, page, { admin = false } = {}) {
  const { editRepo: repo, editPath: path, editMode: mode, editSha: sha, editNote: note } = dataset
  if (!repo || !path || mode === "file") return null
  if (!admin && adminOnly(repo, path)) return null
  if (mode === "scratchpad")
    return {
      label: "Edit in Scratchpad",
      title: "Opens a copy of the notebook in your Scratchpad",
      href: forkUrl(path),
    }
  return {
    label: "Edit",
    title: `Edit ${path.split("/").pop()}, this page's source`,
    href: editUrl({ repo, path, page, sha, note }),
  }
}

/** Put the Edit button first in a page's tools row (`admin`: the member is an admin). */
export function mountEditButton(tools, { admin = false } = {}) {
  const action = editAction(tools.dataset, location.pathname, { admin })
  if (!action) return
  tools.prepend(
    h("a", { class: "page-edit", href: action.href, title: action.title, text: action.label }),
  )
}
