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
    // A conflict to settle (settle.js).
    conflict: params.get("conflict"),
    // From a page's History: the version to restore, or the change to undo, and the file's
    // name at that commit when it moved since.
    restore: params.get("restore"),
    undo: params.get("undo"),
    from: params.get("from"),
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
      if (draft.conflict) return heldNotice(draft.conflict)
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
      ? `${other.author || other.login} (sent, goes in ${publishLabel(other.due_at, now, locale)})`
      : `${other.author || other.login} (${other.status === "editing" ? "not sent yet" : other.status === "conflict" ? "waiting to be settled" : other.status})`
  const names = others.map(one)
  const list = names.length < 2 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
  return `${others.length === 1 ? "Another member has" : "Other members have"} a draft of this file too: ${list}. If your change touches the same lines as one sent before it, you'll see theirs and choose what to do.`
}

/** The Send button's words: a public page's edit is published, a private one's sent for review. */
export function sendLabel(repo, draft) {
  const again = draft?.status !== "editing" && draft?.status !== undefined
  if (repo === "vault") return again ? "Publish the new version" : "Publish"
  return draft?.pull ? "Send the new version" : "Send"
}

/**
 * The words beside the comparison with main's newer version of the page. `rebase`: the Worker
 * merged main's changes with the member's, which touch other lines. `main`: some of the same
 * lines changed, and the member settles those.
 */
export function compareWords(kind, repo) {
  const send = repo === "vault" ? "publish" : "send"
  if (kind === "rebase")
    return {
      message: `Someone changed this page while you were editing. Your changes don't touch the same lines, so we merged them. The marks show what differs from their version: look it over, then ${send}.`,
      done: "It looks right",
      after: `Your draft has their changes now: ${send} it when you're ready.`,
      labels: { keep: "Keep mine", take: "Take main's" },
    }
  return {
    message: `Someone changed this page since you started, on some of the same lines. Their other changes are merged in already. Where the marks show a difference from their version, keep yours or take theirs; then say you're done, and ${send} it again.`,
    done: "I've taken in their changes",
    after: `Your draft is on the newest version now: ${send} it when you're ready.`,
    labels: { keep: "Keep mine", take: "Take main's" },
  }
}

/** The words beside the comparison with another member's sent version, to edit on top of it. */
export function stackWords(other, repo) {
  const name = other?.author || other?.login || "the other member"
  const send = repo === "vault" ? "publish" : "send"
  return {
    message: `You're editing on top of ${name}'s version. Their other changes are merged in already. Where the marks show a difference from their version, keep yours or take theirs; then say you're done, and ${send} it. Yours goes in after theirs.`,
    done: "I've taken in their changes",
    after: `Your draft is on top of ${name}'s version now: ${send} it when you're ready.`,
    labels: { keep: "Keep mine", take: "Take theirs" },
  }
}

/** What to say about a page moved or deleted on main while the member edited it. */
export const movedNotice = () =>
  "This page was moved or deleted. Copy your text, then discard this draft."

/** After a send: others whose sent changes to the same page go in beside this one. */
export function besideNote(beside) {
  if (!beside?.length) return ""
  const names = [...new Set(beside.map((other) => other.author || other.login))]
  const list = names.length < 2 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
  return ` ${list} also changed this page, on other lines: both changes go in.`
}

/** What a refused send says in the status line, in plain words. */
export function sendRefusal(body) {
  if (body.kind === "rebase")
    return "This page changed while you were editing. We merged the changes."
  if (body.kind === "main")
    return "This page changed while you were editing, on some of the same lines."
  if (body.kind === "moved") return "This page was moved or deleted since you started editing."
  return body.detail ?? "That didn't go through."
}

const clock = (at, locale) =>
  new Date(at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })

/**
 * The conflict dialog's words (conflict.js) for a send refused with `kind: "pending"`: another
 * member's sent change touches some of the same lines. Their name comes from the Worker's rows.
 */
export function conflictWords(body, repo, now = Date.now(), locale = undefined) {
  const other = body.with ?? {}
  const name = other.author || other.login || "Another member"
  const verb = repo === "vault" ? "published" : "sent"
  const goes =
    other.due_at > now
      ? ` It goes in ${publishLabel(other.due_at, now, locale)}.`
      : " It goes in with the next hourly run."
  return {
    title: `${name} also changed this page`,
    line: `${name} ${verb} a change at ${clock(other.sent_at ?? now, locale)}.${goes} It changes some of the same lines as yours.`,
    theirs: `Their change, compared with the version you both started from:`,
    queue: `Queue for review: an admin or ${name} will settle it. Your change waits until then.`,
  }
}

/** Who may settle a conflict, in words: its first editor (by name) or an admin. */
const settlers = (conflict) =>
  conflict.first_login ? `${conflict.first_author || conflict.first_login} or an admin` : "an admin"

/** The editor's line for a draft held in a conflict, to its own author. */
export const heldNotice = (conflict) =>
  `Your change is waiting for ${settlers(conflict)} to settle it. Withdraw it to change it yourself.`

/** The editor's line for a conflict the viewer may settle (the first editor, or an admin). */
export function settleNotice(conflict, login) {
  const name = conflict.author || conflict.login
  return conflict.first_login && conflict.first_login.toLowerCase() === login?.toLowerCase()
    ? `${name} has a change that conflicts with yours.`
    : `${name} has a change to this page that conflicts with one sent before it.`
}

/**
 * The settle view's words (settle.js) for a conflict as GET /api/edit/conflicts/:id gives it: the
 * second editor's change against the first one (or against main's version, when no member's
 * change is named), to the first editor ("mine") or an admin.
 */
export function settleWords(detail, now = Date.now(), locale = undefined) {
  const { conflict } = detail
  const second = conflict.author || conflict.login
  const mine = Boolean(conflict.you_first)
  const first = mine ? "you" : conflict.first_author || conflict.first_login || null
  const due = publishLabel(detail.due_at ?? dueAt(now), now, locale)
  return {
    lines: [
      first
        ? `${second} changed some of the same lines of this page as ${first}.`
        : `${second}'s change touches the same lines as a change that went in first.`,
      `The text below has both changes, with ${second}'s lines where both changed the same ones. The marks show where it differs from ${mine ? "your" : "the first"} version: keep ${second}'s line or take ${mine ? "yours" : "the first one's"}.`,
    ],
    first: mine ? "Keep mine" : "Keep the first change",
    second: mine ? "Take theirs" : `Take ${second}'s`,
    labels: { keep: `Keep ${second}'s`, take: mine ? "Take mine" : "Take the first" },
    done: {
      first: `Settled: the first change stays. ${second}'s change goes back to them as a draft.`,
      second: `Settled: ${second}'s change goes in ${due}, after the first one.`,
      merged: `Settled: the merged text goes in ${due}, under ${second}'s name, after the first change.`,
    },
    when: `Settled now, the result goes in ${due}, after the first change, and ${second} can still take it back until then.`,
    closed:
      conflict.state !== "open"
        ? "This conflict is settled already."
        : `Only ${first && !mine ? `${first} or ` : ""}an admin can settle this.`,
  }
}
