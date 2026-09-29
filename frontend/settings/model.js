// Pure helpers for /settings (frontend/settings/index.js), so node:test covers them.

/** The People page fields a member edits, with their labels. Role and group stay with the vault's editors. */
export const FIELDS = [
  ["title", "Name", { required: true, autocomplete: "name" }],
  ["email", "Email", { type: "email", autocomplete: "email" }],
  ["building", "Building", {}],
  ["office", "Office", {}],
  ["scope", "Ask me about", {}],
  ["profile", "Profile link", { type: "url", placeholder: "https://" }],
]

/** The fields whose value differs from the page's (empty counts as none). */
export function changedFields(current, form) {
  const out = {}
  for (const [key] of FIELDS) {
    const value = (form[key] ?? "").trim()
    if (value !== (current[key] ?? "")) out[key] = value || null
  }
  return out
}

/** "ada-lovelace" -> "Ada Lovelace": a People page's name before its page is read. */
export function slugName(slug) {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/** The centred square of an image, for a profile photo. */
export function centreSquare(width, height) {
  const size = Math.min(width, height)
  return { sx: Math.floor((width - size) / 2), sy: Math.floor((height - size) / 2), size }
}

/** The photo the navbar and this page show: an uploaded one, the People page's, or GitHub's. */
export function avatarFor(profile) {
  return (
    profile.avatar ||
    profile.page?.photo ||
    `https://avatars.githubusercontent.com/${encodeURIComponent(profile.login)}?s=128`
  )
}

/** A Wolfram license status line. */
export function licenseSummary(license) {
  if (!license || license.state === "offline")
    return "The compute host is offline, so your license can't be checked right now."
  if (license.state === "active")
    return `Active${license.wolfram_id ? ` for ${license.wolfram_id}` : ""}${
      license.activated_at ? `, since ${new Date(license.activated_at).toLocaleDateString()}` : ""
    }. Your Wolfram code runs on your own license.`
  return "Not activated yet. Wolfram code (the Scratchpad's Wolfram notebooks and Run on guide pages) needs your own Wolfram Engine license."
}

/** When saved changes go into the People page: "at 7:00 PM, in 1 h 23 min". */
export function publishLabel(dueAt, now = Date.now(), locale = undefined) {
  const at = new Date(dueAt).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
  const minutes = Math.max(0, Math.round((dueAt - now) / 60_000))
  const hours = Math.floor(minutes / 60)
  const left = hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`
  return `at ${at}, in ${left}`
}

/** The names of what a saved edit changes, for "Saved: your name and photo". */
export function pendingSummary(pending) {
  const labels = Object.fromEntries(FIELDS.map(([key, label]) => [key, label.toLowerCase()]))
  const parts = (pending?.fields ?? []).map((key) => labels[key] ?? key)
  if (pending?.photo) parts.push("photo")
  if (!parts.length) return ""
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
}
