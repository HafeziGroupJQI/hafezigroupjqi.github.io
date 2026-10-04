// Announcements (the Worker's src/announcements.ts): the words, times and choices the spotlight
// (modal.js) and the /announcements page (index.js) share. Pure, so it runs under node.

export const MAX_TITLE = 200
export const MAX_BODY_BYTES = 50_000
export const MAX_FILE_BYTES = 25 * 1024 * 1024

const dateTime = (at, options = {}) =>
  new Intl.DateTimeFormat(options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: options.timeZone,
  }).format(new Date(at))

export const dateLabel = (at, options = {}) =>
  new Intl.DateTimeFormat(options.locale, {
    dateStyle: "long",
    timeZone: options.timeZone,
  }).format(new Date(at))

/** What an announcement's status says: Draft, Scheduled for …, Live since …. */
export function statusText(announcement, now = Date.now(), options = {}) {
  const at = announcement.publish_at
  if (at === null || at === undefined) return "Draft"
  return at > now ? `Scheduled for ${dateTime(at, options)}` : `Live since ${dateTime(at, options)}`
}

export const statusOf = (announcement, now = Date.now()) =>
  announcement.publish_at === null || announcement.publish_at === undefined
    ? "draft"
    : announcement.publish_at > now
      ? "scheduled"
      : "live"

/** "1 of 3": where the spotlight is among the announcements it shows. */
export const stepLabel = (index, count) => `${index + 1} of ${count}`

/** The Markdown that shows an attachment: an image in place, anything else as a link. */
export function attachmentMarkdown(file) {
  const name = String(file.name ?? "file").replace(/([[\]\\])/g, "\\$1")
  const url = String(file.url).replace(
    /[()\s<>]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
  )
  return /^image\//.test(file.type ?? "") ? `![${name}](${url})` : `[${name}](${url})`
}

/** A file's size, as people say it. */
export function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / 104857.6) / 10} MB`
}

/** A file the Worker would refuse for its size: said before it is sent. */
export const tooBig = (file) =>
  file.size > MAX_FILE_BYTES ? `${file.name} is over 25 MB: attach a smaller file.` : null

const pad = (n) => String(n).padStart(2, "0")

/** A time (ms) as a datetime-local input's value, in this browser's time zone. */
export function toLocalInput(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A datetime-local input's value (this browser's time zone) as a time in ms, or null. */
export function fromLocalInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value ?? "")
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match.map(Number)
  const date = new Date(y, mo - 1, d, h, mi, s || 0)
  // new Date rolls over impossible dates (Feb 30): refuse them instead.
  if (date.getMonth() !== mo - 1 || date.getDate() !== d) return null
  return date.getTime()
}

/** This browser's time zone, for the schedule's label. */
export const timeZoneName = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "your time zone"
  } catch {
    return "your time zone"
  }
}

/**
 * The composer's save buttons for an announcement in `status` (none: a new one), first the main
 * one: [{action, label}]. "keep" saves the text and leaves when it goes live as it is.
 */
export function composerActions(status) {
  if (status === "live")
    return [
      { action: "keep", label: "Save changes" },
      { action: "schedule", label: "Schedule…" },
      { action: "draft", label: "Unpublish to draft" },
    ]
  if (status === "scheduled")
    return [
      { action: "keep", label: "Save changes" },
      { action: "now", label: "Publish now" },
      { action: "schedule", label: "Reschedule…" },
      { action: "draft", label: "Unschedule to draft" },
    ]
  return [
    { action: "now", label: "Publish now" },
    { action: "schedule", label: "Schedule…" },
    { action: "draft", label: "Save draft" },
  ]
}

/** What a save sends for `action`: the fields of PUT/POST /api/announcements. */
export function saveBody({ title, body_md }, action, scheduledAt = null) {
  const body = { title, body_md }
  if (action === "now") body.publish_at = "now"
  else if (action === "draft") body.publish_at = null
  else if (action === "schedule") body.publish_at = scheduledAt
  return body
}

/** Why a save can't go yet (null when it can). */
export function saveProblem({ title, body_md }, action, scheduledAt = null, now = Date.now()) {
  if (title.length > MAX_TITLE) return `The title is too long (at most ${MAX_TITLE} characters).`
  if (new TextEncoder().encode(body_md).length > MAX_BODY_BYTES)
    return "The text is too long (at most 50 kB)."
  if (action !== "draft" && !title.trim()) return "Give the announcement a title first."
  if (action === "schedule") {
    if (scheduledAt === null) return "Choose when it goes live."
    if (scheduledAt <= now) return "Choose a time in the future, or publish it now."
  }
  return null
}

/**
 * Whether the spotlight may open on this page: never inside a frame, nor over an open Scratchpad
 * lab (where the Hafezi GPT button hides too: the lab is someone's work in progress).
 */
export function spotlightAllowed({ framed = false, labOpen = false } = {}) {
  return !framed && !labOpen
}

/** The announcements a closed spotlight dismisses: the ones the member saw in it. */
export const seenIds = (announcements, seen) =>
  announcements.filter((announcement, index) => seen.has(index)).map((a) => a.id)
