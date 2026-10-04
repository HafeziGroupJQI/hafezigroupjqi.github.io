import {
  BULK_FILES,
  PERIOD_DAYS,
  SCORES_SQL,
  SCORES_TTL,
  SCORE_PERIODS,
  type ScorePeriod,
  type ScoreRow,
  contributionScore,
  rankBy,
} from "../changes"
import type { Env } from "../env"
import { HttpError, json } from "../http"
import type { Session } from "../session"
import { readablePage } from "./access"
import { isoDay } from "./views"

// The leaderboard (/leaderboard, frontend/leaderboard/): members by what they wrote and how members
// took it, and the pages members liked most, for the week, the month or all time.
//
// A page's credit goes to its contributors: members with merged changes on it (changes.slug, in
// the form pagePath gives), each by their share of all its merged changes. For a member and period:
//   Contributions = files + 2·√(changes − files)   (changes.ts, MediaWiki's Contribution Scores)
//   Karma         = Σ over pages share × net votes cast on it in the period, less the member's own
//   Reach         = √(Σ over pages share × members who opened it in the period, less the member)
//   Total         = Contributions + 2·Karma + Reach, each to one decimal
// Top pages rank like reddit's "hot": sign(net)·log10(max(|net|, 1)) less the time since the
// page's first vote in the period (its first reader's day, without one) in units of HOT_DECAY:
// one period ago weighs as much as ten times the votes. Readers break ties.
//
// GET /api/leaderboard?period= and /api/leaderboard/pages?period=: two D1 queries for the members
// (contributions from changes; credit over changes, page_votes and page_views, in one batch) and
// one for the pages, kept SCORES_TTL in the isolate. Top pages go through readablePage per member.

const DAY = 86_400_000
/** How long ago a top page's first vote may be before it weighs as ten times fewer votes. */
export const HOT_DECAY: Record<ScorePeriod, number> = {
  week: 7 * DAY,
  month: 30 * DAY,
  all: 365 * DAY,
}
/** Top pages shown, at most. */
export const TOP_PAGES = 50
const TOP_KEPT = 4 * TOP_PAGES

const round1 = (value: number) => Math.round(value * 10) / 10

// A changed file's page as pagePath keys it: a folder's index.md is the folder's page.
const PAGE_OF_SLUG = `CASE WHEN slug LIKE '%/index' THEN substr(slug, 1, length(slug) - 6) ELSE slug END`

// Each member's credit since `?1` (votes) and `?2` (readers' days): the raw sums before the square
// root and rounding. Shares are over all of a page's merged changes, whenever made.
export const CREDIT_SQL = `
  WITH page_changes AS (
    SELECT ${PAGE_OF_SLUG} AS page, login, author
    FROM changes WHERE state = 'merged' AND slug IS NOT NULL
  ),
  totals AS (SELECT page, COUNT(*) AS n FROM page_changes GROUP BY page),
  shares AS (
    SELECT c.page, c.login, MAX(c.author) AS author, COUNT(*) * 1.0 / t.n AS share
    FROM page_changes c JOIN totals t ON t.page = c.page
    WHERE c.login IS NOT NULL
    GROUP BY c.page, c.login COLLATE NOCASE
  ),
  page_net AS (SELECT path, SUM(value) AS net FROM page_votes WHERE at >= ?1 GROUP BY path),
  page_readers AS (
    SELECT path, COUNT(DISTINCT login) AS n FROM page_views WHERE day >= ?2 GROUP BY path
  )
  SELECT s.login AS login,
         MAX(s.author) AS author,
         SUM(s.share * (COALESCE(n.net, 0) - COALESCE(
           (SELECT value FROM page_votes WHERE path = s.page AND login = s.login AND at >= ?1),
           0))) AS votes,
         SUM(s.share * (COALESCE(r.n, 0) - EXISTS
           (SELECT 1 FROM page_views WHERE path = s.page AND login = s.login AND day >= ?2)
         )) AS readers
  FROM shares s
  LEFT JOIN page_net n ON n.path = s.page
  LEFT JOIN page_readers r ON r.path = s.page
  WHERE n.path IS NOT NULL OR r.path IS NOT NULL
  GROUP BY s.login COLLATE NOCASE`

export interface CreditRow {
  login: string
  author: string
  /** Σ share × others' net votes, and Σ share × other readers. */
  votes: number
  readers: number
}

// Every page voted on or read since `?1` / `?2`, with its votes, readers and first of each.
export const PAGES_SQL = `
  WITH v AS (
    SELECT path, SUM(value = 1) AS up, SUM(value = -1) AS down, MIN(at) AS first_vote
    FROM page_votes WHERE at >= ?1 GROUP BY path
  ),
  w AS (
    SELECT path, COUNT(DISTINCT login) AS viewers, MIN(day) AS first_day
    FROM page_views WHERE day >= ?2 GROUP BY path
  ),
  pages AS (SELECT path FROM v UNION SELECT path FROM w)
  SELECT p.path AS path, COALESCE(v.up, 0) AS up, COALESCE(v.down, 0) AS down,
         v.first_vote AS first_vote, COALESCE(w.viewers, 0) AS viewers, w.first_day AS first_day
  FROM pages p LEFT JOIN v ON v.path = p.path LEFT JOIN w ON w.path = p.path`

interface PageRow {
  path: string
  up: number
  down: number
  first_vote: number | null
  viewers: number
  first_day: string | null
}

/** The leaderboard's numbers for a member: Karma, Reach and Total, to one decimal. */
export function memberScore(contributions: number, credit: Pick<CreditRow, "votes" | "readers">) {
  const karma = round1(credit.votes)
  const reach = round1(Math.sqrt(Math.max(0, credit.readers)))
  return { karma, reach, total: round1(contributions + 2 * karma + reach) }
}

/** A member's contributions in a period; a member with credit alone has none (and no last change). */
type Contributions = Omit<ScoreRow, "last_at"> & { last_at: number | null }
const noContributions = (login: string, author: string): Contributions => ({
  login,
  author,
  changes: 0,
  files: 0,
  pages_created: 0,
  pages_edited: 0,
  files_added: 0,
  added: 0,
  removed: 0,
  active_days: 0,
  last_at: null,
})

/** Members by Total: everyone with contributions in the period, or credit from votes or readers. */
export function rankMembers(scores: ScoreRow[], credits: CreditRow[]) {
  const byLogin = new Map(credits.map((credit) => [credit.login.toLowerCase(), credit]))
  const members: { row: Contributions; credit: Pick<CreditRow, "votes" | "readers"> }[] = []
  for (const row of scores) {
    const key = row.login.toLowerCase()
    members.push({ row, credit: byLogin.get(key) ?? { votes: 0, readers: 0 } })
    byLogin.delete(key)
  }
  for (const credit of byLogin.values())
    if (Math.abs(credit.votes) > 1e-9 || credit.readers > 1e-9)
      members.push({ row: noContributions(credit.login, credit.author), credit })
  return rankBy(
    members.map(({ row, credit }) => {
      const contributions = contributionScore(row.files, row.changes)
      return {
        ...row,
        // The contribution score, under the name GET /api/changes/scores gives it too.
        score: contributions,
        contributions,
        ...memberScore(contributions, credit),
        // The sums before rounding and the root, for the cells' explanations.
        credited_votes: Math.round(credit.votes * 100) / 100,
        credited_readers: Math.round(credit.readers * 100) / 100,
      }
    }),
    (row) => row.total,
  )
}

/** A page's hot score: sign(net)·log10(max(|net|, 1)) − age / decay, to four decimals. */
export function hotScore(net: number, firstAt: number, now: number, decay: number): number {
  const order = Math.log10(Math.max(Math.abs(net), 1))
  return Math.round((Math.sign(net) * order - (now - firstAt) / decay) * 10_000) / 10_000
}

/** Pages by hot score, then readers, then net votes, then path. */
export function rankPages(rows: PageRow[], now: number, decay: number) {
  return rows
    .map((row) => {
      const score = row.up - row.down
      const first_at =
        row.first_vote ?? (row.first_day ? Date.parse(`${row.first_day}T00:00:00Z`) : now)
      return {
        path: row.path,
        href: row.path === "index" ? "/" : `/${row.path}`,
        score,
        up: row.up,
        down: row.down,
        viewers: row.viewers,
        first_at,
        hot: hotScore(score, first_at, now, decay),
      }
    })
    .sort(
      (a, b) =>
        b.hot - a.hot ||
        b.viewers - a.viewers ||
        b.score - a.score ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
}

const kept = new Map<string, { at: number; value: unknown }>()
/** Forget the kept leaderboards (tests, and a vote, in its own isolate). */
export const resetLeaderboards = () => kept.clear()

async function keep<T>(key: string, now: number, make: () => Promise<T>): Promise<T> {
  const hit = kept.get(key)
  if (hit && now - hit.at < SCORES_TTL) return hit.value as T
  const value = await make()
  kept.set(key, { at: now, value })
  return value
}

function periodOf(url: URL): ScorePeriod {
  const raw = url.searchParams.get("period") ?? "all"
  if (!SCORE_PERIODS.includes(raw as ScorePeriod))
    throw new HttpError(422, `period must be one of ${SCORE_PERIODS.join(", ")}`)
  return raw as ScorePeriod
}

export async function leaderboardRoutes(
  request: Request,
  url: URL,
  env: Env,
  session: Session,
  now = Date.now(),
): Promise<Response | null> {
  if (url.pathname !== "/api/leaderboard" && url.pathname !== "/api/leaderboard/pages") return null
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method not allowed")
  const period = periodOf(url)
  const days = PERIOD_DAYS[period]
  const since = days === null ? 0 : now - days * DAY
  const head = { period, since: days === null ? null : since }
  if (url.pathname === "/api/leaderboard") {
    const board = await keep(`members:${period}`, now, async () => {
      const [scores, credits] = await env.DB.batch<ScoreRow | CreditRow>([
        env.DB.prepare(SCORES_SQL).bind(since, BULK_FILES),
        env.DB.prepare(CREDIT_SQL).bind(since, isoDay(since)),
      ])
      return {
        ...head,
        generated_at: now,
        bulk_files: BULK_FILES,
        members: rankMembers(scores.results as ScoreRow[], credits.results as CreditRow[]),
      }
    })
    return json(board)
  }
  const board = await keep(`pages:${period}`, now, async () => {
    const { results } = await env.DB.prepare(PAGES_SQL).bind(since, isoDay(since)).all<PageRow>()
    return {
      generated_at: now,
      pages: rankPages(results, now, HOT_DECAY[period]).slice(0, TOP_KEPT),
    }
  })
  // Each member sees only the pages they may read, ranked among themselves.
  const pages = []
  for (const page of board.pages) {
    if (pages.length === TOP_PAGES) break
    if (await readablePage(env, session, page.path)) pages.push({ rank: pages.length + 1, ...page })
  }
  return json({ ...head, generated_at: board.generated_at, hot_decay: HOT_DECAY[period], pages })
}
