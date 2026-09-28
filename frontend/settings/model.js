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

/** A Wolfram licence status line. */
export function licenceSummary(licence) {
  if (!licence || licence.state === "offline")
    return "The compute host is offline, so your licence can't be checked right now."
  if (licence.state === "active")
    return `Active${licence.wolfram_id ? ` for ${licence.wolfram_id}` : ""}${
      licence.activated_at ? `, since ${new Date(licence.activated_at).toLocaleDateString()}` : ""
    }. Your Wolfram code runs on your own licence.`
  return "Not activated yet. Wolfram code (the Scratchpad's Wolfram notebooks and Run on guide pages) needs your own Wolfram Engine licence."
}
