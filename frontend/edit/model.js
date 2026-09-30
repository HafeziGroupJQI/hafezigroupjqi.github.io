// Pure helpers for the page editor (/edit, index.js), so node:test covers them. The editor opens a
// page's own file in its vault (the Worker's src/edit/), never the page the site made from it.

import { publishLabel } from "../settings/model.js"

/** What /edit was opened with: the file (its vault and path), and the page it came from. */
export function editIntent(search) {
  const params = new URLSearchParams(search)
  return {
    repo: params.get("repo"),
    path: params.get("path"),
    // The page the Edit button was on, and the blob that page was built from.
    page: params.get("page"),
    sha: params.get("sha"),
    // "generated": the site wraps the file's text in parts it makes itself (home, places).
    note: params.get("note"),
  }
}

export const REPO_LABELS = { vault: "Public vault", "vault-private": "Private vault" }

/** The file's name, for the page's heading. */
export const fileName = (path) => path.split("/").pop()

/**
 * The line separator a file uses, which the editor keeps: CodeMirror splits on any, and joins with
 * this one, so a file saved unchanged is byte-identical.
 */
export const lineSeparator = (text) => (/\r\n/.test(text) ? "\r\n" : "\n")

/** A one-line summary, as the Worker keeps it (src/edit/rules.ts cleanSummary). */
export const cleanSummary = (text) => (text ?? "").replace(/\s+/g, " ").trim()

/** Where the browser keeps unsaved text of a file (localStorage, this viewer only). */
export const storageKey = (repo, path) => `hafezi:edit:${repo}:${path}`

/**
 * The text to start from: the member's own unsaved text in this browser when it is newer than the
 * draft (or main's version) it was typed over, else the saved draft, else main's file.
 */
export function startingText({ main, draft }, local) {
  const saved = draft?.text ?? main?.text ?? ""
  const base = draft?.base_sha ?? main?.sha ?? null
  if (
    local &&
    local.text !== saved &&
    local.base === base &&
    (!draft || local.at > draft.edited_at)
  )
    return { text: local.text, restored: true }
  return { text: saved, restored: false }
}

const when = (at, locale) =>
  new Date(at).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })

/** What to say when the draft was saved somewhere else since this tab loaded it. */
export const staleNotice = (newer, locale = undefined) =>
  `You saved a newer version of this draft somewhere else (${when(newer.edited_at, locale)}). Use that version, or keep the text in this window and save it over that one.`

/** Where the member's draft stands, in a sentence. */
export function draftStatus(draft, now = Date.now(), locale = undefined) {
  if (!draft) return "Not saved yet."
  const review = Boolean(draft.review)
  switch (draft.status) {
    case "editing":
      return `Draft saved ${when(draft.edited_at, locale)}, not sent yet.`
    case "open":
      if (draft.unsent)
        return draft.repo === "vault"
          ? "Changed since you published it: publish it again (its hour starts over)."
          : "Changed since you sent it: send it again (its hour starts over)."
      if (draft.due_at > now && draft.repo === "vault")
        return `Published: it goes into the public vault ${publishLabel(draft.due_at, now, locale)}. Until then only you see it.`
      if (draft.due_at > now)
        return review
          ? `Sent: an admin merges it after checking it, since something in it runs.`
          : `Sent: it goes in ${publishLabel(draft.due_at, now, locale)}, once the vault's check passes.`
      return draft.detail?.message
        ? `Waiting for the next hourly run: ${draft.detail.message}.`
        : "Waiting for the next hourly run."
    case "failed":
      return draft.repo === "vault"
        ? `It didn't go in${draft.detail?.message ? ` (${draft.detail.message})` : ""}: fix it and publish it again.`
        : `The vault's check failed${draft.detail?.message ? ` (${draft.detail.message})` : ""}: fix it and send it again.`
    case "conflict":
      return draft.repo === "vault"
        ? "The page changed on main since you started: take in what changed and publish it again."
        : "Main changed this page since you sent it: take in what changed and send it again."
    case "review":
      return "Checked: waiting for an admin to merge it, since something in it runs."
    case "merged":
      return `Merged ${draft.merged_at ? when(draft.merged_at, locale) : ""}.`.replace(" .", ".")
    case "discarded":
      return "Discarded."
    default:
      return draft.status
  }
}

/** When a draft sent at `now` goes in: the end of the hour after this one (src/profile/routes.ts). */
export const dueAt = (now) => Math.floor(now / 3_600_000) * 3_600_000 + 7_200_000

/** When an edit sent now would go in, and what happens next, for the Send button's hint. */
export function sendHint(source, now = Date.now(), locale = undefined) {
  if (source.repo === "vault")
    return `Published now, it goes into the public vault ${publishLabel(dueAt(now), now, locale)}, and the public page shows it about 3 minutes after that. Until then only you see it, and you can change it or discard it.`
  if (source.review)
    return `Sending opens a pull request; an admin merges it after checking it, since ${source.review}.`
  return `Sent now, it goes in ${publishLabel(dueAt(now), now, locale)} if the vault's check passes, and members' pages show it about 15 minutes after that. Until then you can change it or discard it.`
}

/** Other members' drafts of the same file, in a sentence (or null for none). */
export function othersNotice(others, now = Date.now(), locale = undefined) {
  if (!others?.length) return null
  const one = (other) =>
    other.status === "open" && other.due_at > now
      ? `${other.login} (sent, goes in ${publishLabel(other.due_at, now, locale)})`
      : `${other.login} (${other.status === "editing" ? "not sent yet" : other.status})`
  const names = others.map(one)
  const list = names.length < 2 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
  return `${others.length === 1 ? "Another member has" : "Other members have"} a draft of this file too: ${list}. Whoever sends second must take in the first one's changes.`
}

/** The Send button's words: a public page's edit is published, a private one's sent for review. */
export function sendLabel(repo, draft) {
  const again = draft?.status !== "editing" && draft?.status !== undefined
  if (repo === "vault") return again ? "Publish the new version" : "Publish"
  return draft?.pull ? "Send the new version" : "Send"
}
