// Pure helpers for a page's History (frontend/page-history/index.js), so node:test covers them. A
// history is the build's <slug>.history.json (quartz/plugins/local/page-history/): the page's own
// file in its vault and that file's revisions, newest first (tools/history.mjs).

import { notebookToQmd } from "../notebook-page/exporting.js"

/** The vaults on GitHub. */
export const REPOS = {
  vault: "HafeziGroupJQI/vault",
  "vault-private": "HafeziGroupJQI/vault-private",
}

const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/")

/**
 * Where a file's text at a commit comes from: the public vault's straight from GitHub, which
 * anyone may read (signed out too); the private vault's through the Worker, for members only.
 */
export function revisionUrl(repo, commit, path) {
  if (repo === "vault")
    return `https://raw.githubusercontent.com/${REPOS.vault}/${commit}/${encodePath(path)}`
  return `/api/history/file?${new URLSearchParams({ repo, rev: commit, path })}`
}

export const commitUrl = (repo, commit) => `https://github.com/${REPOS[repo]}/commit/${commit}`

/** The file's full history on GitHub, older revisions included. */
export const fileHistoryUrl = (repo, path) =>
  `https://github.com/${REPOS[repo]}/commits/main/${encodePath(path)}`

/** Whether the History compares a file's versions: not a Wolfram notebook's, whose text is its
 *  whole front end's state (the Worker serves pages' only, worker/src/history.ts). */
export const comparableFile = (path) => /\.(?:md|qmd|ipynb)$/i.test(path)

/** A revision's file as it was after that commit, or null when the commit deleted it. */
export function versionAt(revision) {
  return revision.kind === "delete" ? null : { commit: revision.commit, path: revision.path }
}

/** The file just before a revision (its parent commit, under its old name if it moved), or null. */
export function versionBefore(revision) {
  if (revision.kind === "new" || !revision.parent) return null
  return { commit: revision.parent, path: revision.from ?? revision.path }
}

/** What a revision did, in words: "created", "edited", "moved from notes/a.md", "deleted". */
export function kindLabel(revision) {
  if (revision.kind === "rename") return `moved from ${revision.from}`
  return { new: "created", delete: "deleted" }[revision.kind] ?? "edited"
}

/** "+12 −3" for a revision's lines, or "" when they weren't counted. */
export function lineCounts(revision) {
  if (revision.added == null && revision.removed == null) return ""
  return `+${revision.added ?? 0} −${revision.removed ?? 0}`
}

/**
 * Where a revision's author links: signed-in members to their contributions on /recent; everyone
 * else to their People page, when the author has one. null for neither.
 */
export function authorHref(revision, { members = false } = {}) {
  if (members && revision.login) return `/recent?${new URLSearchParams({ user: revision.login })}`
  return revision.page ? `/${revision.page}` : null
}

/**
 * The two versions to compare for revisions `a` and `b` (indexes into the newest-first list): the
 * older one's file after its commit, then the newer one's.
 */
export function comparePair(revisions, a, b) {
  const [older, newer] = a > b ? [a, b] : [b, a]
  return [versionAt(revisions[older]), versionAt(revisions[newer])]
}

/**
 * A file's text as the History compares it: a Jupyter notebook as the Quarto document it reads as
 * (its cells' source, not its outputs' JSON), anything else as it is.
 */
export function comparable(path, text) {
  if (!/\.ipynb$/i.test(path) || text === null) return text ?? ""
  try {
    const notebook = JSON.parse(text)
    if (Array.isArray(notebook?.cells)) return notebookToQmd(notebook)
  } catch {}
  return text
}

/**
 * A revision's Restore and Undo, links to the page editor (frontend/edit/), for members: restore
 * the file as it was after the commit (not the newest, nor a deletion), or undo the commit's
 * change (an edit of a Markdown or Quarto page). None when the page's Edit doesn't open the
 * editor (`edit` is its tools row's data-edit-*: a Wolfram notebook or a file replaced whole).
 */
export function revertLinks(revision, index, edit, page = null) {
  const { editRepo: repo, editPath: path, editMode: mode } = edit ?? {}
  if (!repo || !path || mode === "file" || mode === "scratchpad") return []
  if (!/^[0-9a-f]{40}$/.test(revision.commit ?? "")) return []
  const link = (key) => {
    const params = new URLSearchParams({ repo, path })
    if (page) params.set("page", page)
    params.set(key, revision.commit)
    if (revision.path && revision.path !== path) params.set("from", revision.path)
    return `/edit?${params}`
  }
  const links = []
  if (index > 0 && revision.kind !== "delete")
    links.push({ label: "Restore this version", href: link("restore") })
  if (revision.kind === "edit" && revision.parent && /\.(?:md|qmd)$/i.test(path))
    links.push({ label: "Undo this change", href: link("undo") })
  return links
}
