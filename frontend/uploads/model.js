// Pure helpers for /uploads (frontend/uploads/index.js) and the admin console's Uploads tab, so
// node:test covers them. A draft is the Worker's view of one (worker/src/uploads/drafts.ts).

import { publishLabel } from "../settings/model.js"

/** Drafts the member can still change, send or discard. */
export const LIVE = ["editing", "open", "failed", "conflict", "review"]

export const isLive = (draft) => LIVE.includes(draft.status)

/** "1.2 MB", "340 KB", "12 bytes". */
export function formatBytes(bytes) {
  if (bytes == null) return ""
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** One change of a draft, in words: "Add notes/a.pdf (1.2 MB)", "Move a.pdf to b/a.pdf". */
export function changeLabel(change) {
  if (change.action === "rename") return `Move ${change.from} to ${change.path}`
  const verb = { add: "Add", replace: "Replace", delete: "Delete" }[change.action] ?? change.action
  return `${verb} ${change.path}${change.size != null ? ` (${formatBytes(change.size)})` : ""}`
}

/** A draft's name on its card: the first line of its note, else when it was started. A page
 *  edit's is its summary, else its page's file. */
export function draftName(draft, locale = undefined) {
  if (draft.kind === "edit") return draft.summary || `Edit of ${draft.path}`
  const line = (draft.note ?? "").split("\n")[0].trim()
  if (line) return line.length > 80 ? `${line.slice(0, 79)}…` : line
  const started = new Date(draft.created_at).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
  return `Draft started ${started}`
}

/** Where a draft stands, in a sentence. `check` is the pull request's check so far, if read. */
export function statusLabel(draft, now = Date.now(), locale = undefined) {
  const review = Boolean(draft.review)
  switch (draft.status) {
    case "editing":
      return draft.changes.length ? "Not sent yet" : "Empty: add files, or move or delete some"
    case "open":
      if (draft.unsent) return "Changed since you sent it: send it again (its hour starts over)"
      if (draft.check?.state === "failure" || draft.check?.state === "error")
        return "The vault's check failed: fix the files and send it again"
      if (draft.due_at > now)
        return review
          ? `Checked, then left for an admin to merge ${publishLabel(draft.due_at, now, locale)}, since something in it runs`
          : `Merges into the vault ${publishLabel(draft.due_at, now, locale)}, if the vault's check passes`
      return draft.detail?.message
        ? `Waiting for the next hourly merge: ${draft.detail.message}`
        : "Waiting for the next hourly merge"
    case "failed":
      return "The vault's check failed: fix the files and send it again"
    case "conflict":
      return "Main changed the same files: send it again to rebuild it on main"
    case "review":
      return "Checked: waiting for an admin to merge it on GitHub, since something in it runs"
    case "merged":
      return `Merged${draft.merged_at ? ` ${new Date(draft.merged_at).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}`
    case "discarded":
      return `Discarded${draft.detail?.message ? `: ${draft.detail.message}` : ""}`
    default:
      return draft.status
  }
}

/** The folder a path is in ("" for the top of the vault). */
export const folderOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf("/")))

export const joinPath = (folder, name) => (folder ? `${folder}/${name}` : name)

/** The breadcrumbs of a folder: the vault, then each folder down to it. */
export function crumbs(folder) {
  const parts = folder ? folder.split("/") : []
  return [
    { name: "vault-private", path: "" },
    ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") })),
  ]
}

const extension = (name) => /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? ""

/** Why a file can't be uploaded before it is sent (the Worker checks again), or null. */
export function fileProblem(file, { types, limits }) {
  const ext = extension(file.name)
  if (!types.includes(ext))
    return `${file.name}: ${ext ? `.${ext} files` : "files without an extension"} can't be uploaded`
  if (file.size === 0) return `${file.name} is empty`
  if (file.size > limits.file)
    return `${file.name} is ${formatBytes(file.size)}; a file can be at most ${formatBytes(limits.file)}`
  return null
}

/** Why a file can't be the new version of the one at `path` (a file keeps its type), or null. */
export function replaceProblem(file, path, state) {
  const problem = fileProblem(file, state)
  if (problem) return problem
  const ext = extension(path)
  return extension(file.name) === ext ? null : `${path} can only be replaced by a .${ext} file`
}

/** What /uploads was opened to do: show a draft, or replace or move a file (a page's tools). */
export function intentOf(search) {
  const params = new URLSearchParams(search)
  return {
    draft: params.get("draft"),
    replace: params.get("replace"),
    rename: params.get("rename"),
  }
}

/** The draft a page's "Replace this file…" or "Move…" adds to: the newest upload never sent. */
export function draftForPage(drafts) {
  return drafts.find((draft) => draft.status === "editing" && draft.kind !== "edit") ?? null
}

/** The /uploads link a page's tools use for a file of the vault. */
export const uploadsUrl = (intent, path) => `/uploads?${new URLSearchParams({ [intent]: path })}`
