// Pure helpers for the members' Leaderboard (/leaderboard, frontend/leaderboard/index.js), so
// node:test covers them: its address, the Worker's two boards (worker/src/ratings/leaderboard.ts,
// GET /api/leaderboard and /api/leaderboard/pages) and each row's cells.

/** The leaderboard's periods, as its URL carries them, with what each button says. */
export const PERIODS = [
  ["week", "This week"],
  ["month", "This month"],
  ["all", "All time"],
]
export const DEFAULT_PERIOD = "all"

/** Its tabs. */
export const TABS = [
  ["members", "Members"],
  ["pages", "Top pages"],
]
export const DEFAULT_TAB = "members"

const pick = (options, value, fallback) =>
  options.some(([key]) => key === value) ? value : fallback

/** The tab and period the address asks for (?tab=pages&period=week); unknown values are dropped. */
export function stateOf(search) {
  const query = new URLSearchParams(search)
  return {
    tab: pick(TABS, query.get("tab"), DEFAULT_TAB),
    period: pick(PERIODS, query.get("period"), DEFAULT_PERIOD),
  }
}

/** The page's query string for a tab and period ("" for the defaults), as stateOf reads it. */
export function stateSearch({ tab, period }) {
  const query = new URLSearchParams()
  if (tab && tab !== DEFAULT_TAB) query.set("tab", tab)
  if (period && period !== DEFAULT_PERIOD) query.set("period", period)
  const text = query.toString()
  return text ? `?${text}` : ""
}

/** The Worker's boards for a period. */
export const membersUrl = (period) => `/api/leaderboard?period=${encodeURIComponent(period)}`
export const pagesUrl = (period) => `/api/leaderboard/pages?period=${encodeURIComponent(period)}`

/** A member's contributions on /recent. */
export const contributionsHref = (login) => `/recent?${new URLSearchParams({ user: login })}`

/** The contribution score's formula with a member's own numbers. */
export function scoreTitle(member) {
  const repeats = Math.max(0, member.changes - member.files)
  return `${member.files} files + 2 × √${repeats} repeat changes = ${member.score}`
}

const fmt = (value) => String(Math.round(value * 100) / 100)

/** What each of a member's numbers comes from, for its cell's tooltip. */
export function memberTitles(member) {
  return {
    total: `${member.contributions} + 2 × ${member.karma} + ${member.reach} = ${member.total}`,
    contributions: scoreTitle({ ...member, score: member.contributions }),
    karma: `Net votes by other members on pages ${member.author || member.login} wrote, by their share of each page's changes: ${fmt(member.credited_votes)}`,
    reach: `√${fmt(member.credited_readers)} members who read those pages, by the same shares = ${member.reach}`,
  }
}

/** The members' table: few enough columns to fit, the Total first. */
export const MEMBER_COLUMNS = [
  "Rank",
  "Member",
  "Total",
  "Contributions",
  "Karma",
  "Reach",
  "Files",
  "Changes",
  "Last change",
]

/** A member's row as cells: text, and for some a link or a tooltip. In MEMBER_COLUMNS' order. */
export function memberCells(member, locale = undefined) {
  const name = member.author || member.login
  const titles = memberTitles(member)
  return [
    String(member.rank),
    { text: name, href: contributionsHref(member.login), title: `${name}'s contributions` },
    { text: String(member.total), title: titles.total },
    { text: String(member.contributions), title: titles.contributions },
    { text: String(member.karma), title: titles.karma },
    { text: String(member.reach), title: titles.reach },
    String(member.files),
    String(member.changes),
    member.last_at == null
      ? "—"
      : new Date(member.last_at).toLocaleDateString(locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
  ]
}

/**
 * A page's title from the site's content index (keyed by slug: a folder's page is its index), or
 * its last path segment, readable.
 */
export function pageTitle(path, titles = {}) {
  const known = titles[path]?.title ?? titles[`${path}/index`]?.title
  if (known) return known
  if (path === "index") return "Home"
  return path.split("/").pop().replace(/-/g, " ")
}

export const PAGE_COLUMNS = ["Rank", "Page", "Score", "Up", "Down", "Readers"]

/** A top page's row as cells, in PAGE_COLUMNS' order. */
export function pageCells(page, titles = {}) {
  const title = pageTitle(page.path, titles)
  return [
    String(page.rank),
    { text: title, href: page.href, title: page.href },
    { text: String(page.score), title: `${page.up} up, ${page.down} down` },
    String(page.up),
    String(page.down),
    String(page.viewers),
  ]
}

/** What each tab's numbers mean, in plain sentences for the page. */
export const MEMBERS_SENTENCE =
  "Total = Contributions + 2 × Karma + Reach. Contributions count the different files you changed plus 2 × the square root of your further changes to them. Karma is the net of other members' votes on pages you wrote, and Reach the square root of how many other members read them; both are shared among a page's authors by how many of its changes each made."
const AGE_UNIT = { week: "a week", month: "a month", all: "a year" }
export const pagesSentence = (period) =>
  `Pages by members' votes, ranked as reddit's "hot" ranks posts: a page first voted on ${AGE_UNIT[period] ?? AGE_UNIT.all} earlier needs ten times the net votes to rank level with a newer one. Pages level on votes go by how many members read them.`
/** What is counted, under the members' table. */
export const membersNotes = (bulkFiles = 50) =>
  `Only changes that are in the vault count, and your own votes and visits never count for you. A bulk import (one commit with more than ${bulkFiles} files) counts once for each folder it touched. The Contributions formula is the one MediaWiki's Contribution Scores uses.`
