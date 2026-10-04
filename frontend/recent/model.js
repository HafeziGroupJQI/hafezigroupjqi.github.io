// Pure helpers for the members' Recently modified page (frontend/recent/index.js), so node:test
// covers them. A change is the Worker's view of one row of D1 changes (worker/src/changes.ts).

import { stateOf, stateSearch } from "../leaderboard/model.js"

/** The page's filters, as its URL and the form carry them, with what each option shows. */
export const REPOS = [
  ["", "Both vaults"],
  ["vault", "Public vault"],
  ["vault-private", "Private vault"],
]
export const KINDS = [
  ["", "Every kind"],
  ["new", "New pages and files"],
  ["edit", "Edits"],
  ["rename", "Moves"],
  ["delete", "Deletions"],
  ["upload", "Uploads"],
  ["profile", "People pages from Settings"],
]
/** States by what a reader asks: what's in the vault, what waits, what went wrong. */
export const STATES = [
  ["", "Any state"],
  ["merged", "In the vault"],
  ["pending", "Waiting to go in"],
  ["attention", "Check failed or conflicted"],
  ["discarded", "Discarded"],
]
const STATE_VALUES = {
  merged: ["merged"],
  pending: ["draft", "sent", "review"],
  attention: ["failed", "conflict"],
  discarded: ["discarded"],
}

const pick = (options, value) => (options.some(([key]) => key === value) ? value : "")

/** The filters in a query string (?user=ada&kind=edit): unknown values are dropped. */
export function filtersOf(search) {
  const query = new URLSearchParams(search)
  return {
    user: (query.get("user") ?? "").trim().replace(/^@/, ""),
    repo: pick(REPOS, query.get("repo") ?? ""),
    kind: pick(KINDS, query.get("kind") ?? ""),
    state: pick(STATES, query.get("state") ?? ""),
  }
}

/** The page's query string for `filters` ("" for none), as filtersOf reads it. */
export function searchOf(filters) {
  const query = new URLSearchParams()
  for (const key of ["user", "repo", "kind", "state"])
    if (filters[key]) query.set(key, filters[key])
  const text = query.toString()
  return text ? `?${text}` : ""
}

/** The Worker's feed for `filters`, from the cursor `before` (the previous page's next). */
export function feedUrl(filters, before = null) {
  const query = new URLSearchParams()
  if (filters.user) query.set("login", filters.user)
  if (filters.repo) query.set("repo", filters.repo)
  if (filters.kind) query.set("kind", filters.kind)
  if (filters.state) query.set("state", STATE_VALUES[filters.state].join(","))
  if (before) query.set("before", before)
  const text = query.toString()
  return `/api/changes${text ? `?${text}` : ""}`
}

/** A page's path on the site: "/" for the home page, a folder's index as the folder. */
export function pageHref(slug) {
  if (slug === "index") return "/"
  return `/${slug.replace(/(^|\/)index$/, "$1")}`
}

const fileName = (path) => path.split("/").pop()

/**
 * What a change did, in words, and to what: {verb, text, href, after}, read "<who> <verb> <text>
 * <after>". `titles` maps a page's slug to its title (the site's content index); a file that isn't
 * a page, or is gone, shows its name.
 */
export function describe(change, titles = {}) {
  const page = change.slug && change.kind !== "delete" ? change.slug : null
  const text = (page && titles[page]?.title) || fileName(change.path)
  const verb =
    {
      new: page ? "created" : "added",
      edit: "edited",
      rename: `moved ${fileName(change.from ?? "")} to`,
      delete: "deleted",
      upload: "uploaded",
      profile: "updated",
    }[change.kind] ?? change.kind
  const after = change.kind === "profile" ? "in Settings" : ""
  return { verb, text, href: page ? pageHref(page) : null, after }
}

/** A change's state when it isn't simply in the vault, for its badge; null when it is. */
export function stateLabel(state) {
  return (
    {
      draft: "draft",
      sent: "waiting for its hour",
      review: "waiting for an admin",
      failed: "check failed",
      conflict: "conflict",
      discarded: "discarded",
    }[state] ?? null
  )
}

/** "+12 −3" for a page's lines, or "" without counts. */
export function lineCounts(change) {
  if (change.added == null && change.removed == null) return ""
  return `+${change.added ?? 0} −${change.removed ?? 0}`
}

/** The heading of a change's day: Today, Yesterday, or its date. */
export function dayLabel(at, now = Date.now(), locale = undefined) {
  const day = (time) => new Date(time).toDateString()
  if (day(at) === day(now)) return "Today"
  if (day(at) === day(now - 86_400_000)) return "Yesterday"
  return new Date(at).toLocaleDateString(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(new Date(at).getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  })
}

// ---- the Contributions tab's old addresses: the leaderboard is /leaderboard now ----

/** Where an address of the old Contributions tab (?view=contributions&period=week) goes, or null. */
export function leaderboardRedirect(search) {
  if (new URLSearchParams(search).get("view") !== "contributions") return null
  return `/leaderboard${stateSearch({ tab: "members", period: stateOf(search).period })}`
}
