import type { Env } from "./env"
import { HttpError, json } from "./http"

// The site's activity (D1 changes, migration 0014), like MediaWiki's recentchanges: each change to
// a file of either vault, one row per file. Every members deploy imports both vaults' commits
// (tools/changes-import.mjs); the Worker records what members do on the site as they do it, so a
// change shows here from the moment it is sent, not only once it is merged. GET /api/changes is
// the members' /recent feed (frontend/recent/), each member's contributions (?login=) and a page's
// pending changes (?path=). Members only: it names the private vault's files and unmerged work.

export type ChangeRepo = "vault" | "vault-private"
export type ChangeKind = "new" | "edit" | "rename" | "delete" | "upload" | "profile"
export type ChangeState =
  "draft" | "sent" | "review" | "failed" | "conflict" | "merged" | "discarded"

export const REPOS: ChangeRepo[] = ["vault", "vault-private"]
export const KINDS: ChangeKind[] = ["new", "edit", "rename", "delete", "upload", "profile"]
export const STATES: ChangeState[] = [
  "draft",
  "sent",
  "review",
  "failed",
  "conflict",
  "merged",
  "discarded",
]

export interface ChangeRow {
  id: number
  at: number
  login: string | null
  author: string
  repo: ChangeRepo
  path: string
  from_path: string | null
  slug: string | null
  kind: ChangeKind
  state: ChangeState
  visibility: "public" | "members"
  summary: string
  commit_sha: string | null
  pr_number: number | null
  draft_id: string | null
  added: number | null
  removed: number | null
  bytes: number | null
  source: "site" | "git"
}

/** Rows per page of the feed, and at most. */
export const PAGE = 50
export const PAGE_MAX = 100

/** A vault's "owner/name" on GitHub. */
export const repoName = (env: Env, repo: ChangeRepo) =>
  repo === "vault"
    ? env.VAULT_REPO || "HafeziGroupJQI/vault"
    : env.DOCS_REPO || "HafeziGroupJQI/vault-private"

// ---- what the site records as members act: one statement each, since a Workers Free invocation
// may make 50 D1 queries, the hourly runs' included ----

/** A vault file's page on the site, or null (tools/changes-import.mjs's pageSlug, for commits). */
export function pageSlug(repo: ChangeRepo, path: string): string | null {
  if (repo === "vault") return /^content\/(.+)\.md$/.exec(path)?.[1] ?? null
  const page = /^(.+)\.(?:md|qmd|ipynb|nb)$/.exec(path)?.[1]
  return page ? `resources/${page}` : null
}

/** A change the site made to one file. */
export interface SiteChange {
  at: number
  login: string
  author: string
  repo: ChangeRepo
  path: string
  from_path?: string | null
  kind: ChangeKind
  state: ChangeState
  summary: string
  commit_sha?: string | null
  pr_number?: number | null
  draft_id?: string | null
  bytes?: number | null
}

const SITE_COLUMNS = [
  "at",
  "login",
  "author",
  "repo",
  "path",
  "from_path",
  "slug",
  "kind",
  "state",
  "summary",
  "commit_sha",
  "pr_number",
  "draft_id",
  "bytes",
] as const

/**
 * The statement recording changes the site made, all of them at once. A commit's file that the
 * deploy's import recorded first gives way to the site's row, which knows its draft and pull
 * request.
 */
export function recordChanges(env: Pick<Env, "DB">, changes: SiteChange[]): D1PreparedStatement {
  const rows = changes.map((change) => ({
    from_path: null,
    commit_sha: null,
    pr_number: null,
    draft_id: null,
    bytes: null,
    ...change,
    slug: change.kind === "delete" ? null : pageSlug(change.repo, change.path),
  }))
  return env.DB.prepare(
    `INSERT OR REPLACE INTO changes (${SITE_COLUMNS.join(", ")}, source)
     SELECT ${SITE_COLUMNS.map((column) => `json_extract(value, '$.${column}')`).join(", ")}, 'site'
     FROM json_each(?)`,
  ).bind(JSON.stringify(rows))
}

/** A draft's files as the changes it sends: an upload's each, or the page an edit changes. */
export function draftChanges(
  draft: { id: string; login: string; repo?: ChangeRepo; kind?: "upload" | "edit" },
  files: {
    path: string
    action: "add" | "replace" | "rename" | "delete"
    from_path: string | null
    size: number | null
  }[],
  sent: { at: number; author: string; summary: string; pull: number | null },
): SiteChange[] {
  return files.map((file) => ({
    at: sent.at,
    login: draft.login,
    author: sent.author,
    repo: draft.repo ?? "vault-private",
    path: file.path,
    from_path: file.from_path,
    kind:
      file.action === "rename" || file.action === "delete"
        ? file.action
        : draft.kind !== "edit"
          ? "upload"
          : file.action === "add"
            ? "new"
            : "edit",
    state: "sent",
    summary: sent.summary,
    pr_number: sent.pull,
    draft_id: draft.id,
    bytes: file.size,
  }))
}

/**
 * The statement moving a draft's changes on (merged with its commit on main, refused, discarded),
 * once the draft itself stands so (upload_drafts.status, whose words these are): a revision sent
 * meanwhile keeps its changes as sent. Batched with the draft's own update, so it costs the hourly
 * runs no request of its own. A merged change stays merged; a commit's file that the deploy's
 * import recorded first gives way, as in recordChanges.
 */
export function settleChanges(
  env: Pick<Env, "DB">,
  draft: string,
  state: "review" | "failed" | "conflict" | "merged" | "discarded",
  { commit = null, at = Date.now() }: { commit?: string | null; at?: number } = {},
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE OR REPLACE changes SET state = ?1, commit_sha = COALESCE(?2, commit_sha), at = ?3
     WHERE draft_id = ?4 AND state != 'merged'
       AND EXISTS (SELECT 1 FROM upload_drafts WHERE id = ?4 AND status = ?1)`,
  ).bind(state, commit, at, draft)
}

/** The statement taking back a draft's changes not merged yet, before it is sent again. */
export function unsentChanges(env: Pick<Env, "DB">, draft: string): D1PreparedStatement {
  return env.DB.prepare("DELETE FROM changes WHERE draft_id = ? AND state != 'merged'").bind(draft)
}

/** A change as the members site shows it, with its links on GitHub. */
export function changeView(env: Env, row: ChangeRow) {
  const github = `https://github.com/${repoName(env, row.repo)}`
  return {
    id: row.id,
    at: row.at,
    login: row.login,
    author: row.author,
    repo: row.repo,
    path: row.path,
    from: row.from_path,
    slug: row.slug,
    kind: row.kind,
    state: row.state,
    visibility: row.visibility,
    summary: row.summary,
    commit: row.commit_sha
      ? { sha: row.commit_sha, url: `${github}/commit/${row.commit_sha}` }
      : null,
    pull: row.pr_number ? { number: row.pr_number, url: `${github}/pull/${row.pr_number}` } : null,
    draft: row.draft_id,
    added: row.added,
    removed: row.removed,
    bytes: row.bytes,
    source: row.source,
  }
}

/** A comma-separated filter of known values ("edit,rename"), or null for none. */
function oneOf<T extends string>(raw: string | null, known: T[], what: string): T[] | null {
  if (!raw) return null
  const values = [...new Set(raw.split(",").map((value) => value.trim()))].filter(Boolean)
  const unknown = values.find((value) => !known.includes(value as T))
  if (unknown) throw new HttpError(422, `${what} must be one of ${known.join(", ")}`)
  return values.length ? (values as T[]) : null
}

// ---- contributions: each member's score, for the leaderboard on /recent ----
// The score is the formula of MediaWiki's Contribution Scores extension
// (https://www.mediawiki.org/wiki/Extension:Contribution_Scores): pages + 2 × √(changes − pages),
// so every distinct file counts in full and repeat changes to the same file count less and less.
// Its reports are 7 days, 30 days and all time, as here. That extension is GPL-2.0-or-later, so
// only its published formula is used: none of its code is copied; this query and code are our own.
// A "page" is a distinct file of either vault and a "change" is a merged row. A bulk commit (more
// than BULK_FILES files at once, an import) counts once per folder it touched, not once per file.
// Rows without a member (login NULL: the site's own commits, unknown authors) never rank.

export type ScorePeriod = "week" | "month" | "all"
export const SCORE_PERIODS: ScorePeriod[] = ["week", "month", "all"]
const DAY = 86_400_000
export const PERIOD_DAYS: Record<ScorePeriod, number | null> = { week: 7, month: 30, all: null }
/** A commit with more files than this is a bulk import. */
export const BULK_FILES = 50
/** How long a leaderboard is kept before D1 is asked again. */
export const SCORES_TTL = 5 * 60_000

/** The Contribution Scores formula, to one decimal: files + 2 × √(changes − files). */
export function contributionScore(files: number, changes: number): number {
  return Math.round((files + 2 * Math.sqrt(Math.max(0, changes - files))) * 10) / 10
}

export interface ScoreRow {
  login: string
  author: string
  changes: number
  files: number
  pages_created: number
  pages_edited: number
  files_added: number
  added: number
  removed: number
  active_days: number
  last_at: number
}

/** Rows by `value`, best first, ties sharing a rank (1, 1, 3); a tie goes by name. */
export function rankBy<T extends { author: string }>(rows: T[], value: (row: T) => number) {
  const sorted = [...rows].sort((a, b) => value(b) - value(a) || a.author.localeCompare(b.author))
  return sorted.map((row) => ({
    rank: sorted.findIndex((other) => value(other) === value(row)) + 1,
    ...row,
  }))
}

/** Members by score, best first, ties sharing a rank (1, 1, 3); a tie goes by name. */
export function rankScores(rows: ScoreRow[]) {
  return rankBy(
    rows.map((row) => ({ ...row, score: contributionScore(row.files, row.changes) })),
    (row) => row.score,
  )
}

// One query: every merged change of a member since `?1`, a bulk commit's files folded into the
// folders they are in (rtrim drops the file's name from its path).
export const SCORES_SQL = `
  WITH merged AS (
    SELECT login, author, at, repo, path, slug, kind, added, removed, commit_sha,
           rtrim(path, replace(path, '/', '')) AS folder,
           CASE WHEN commit_sha IS NULL THEN 1
                ELSE COUNT(*) OVER (PARTITION BY repo, commit_sha) END AS commit_files
    FROM changes
    WHERE state = 'merged' AND login IS NOT NULL AND at >= ?1
  )
  SELECT login,
         MAX(author) AS author,
         SUM(commit_files <= ?2)
           + COUNT(DISTINCT CASE WHEN commit_files > ?2
                                 THEN repo || ':' || commit_sha || ':' || folder END) AS changes,
         COUNT(DISTINCT CASE WHEN commit_files > ?2 THEN repo || ':' || folder
                             ELSE repo || ':' || path END) AS files,
         SUM(kind = 'new' AND slug IS NOT NULL) AS pages_created,
         SUM(kind IN ('edit', 'profile') AND slug IS NOT NULL) AS pages_edited,
         SUM(kind = 'upload' OR (kind = 'new' AND slug IS NULL)) AS files_added,
         SUM(COALESCE(added, 0)) AS added,
         SUM(COALESCE(removed, 0)) AS removed,
         COUNT(DISTINCT at / ${DAY}) AS active_days,
         MAX(at) AS last_at
  FROM merged
  GROUP BY login`

const scoresCache = new Map<ScorePeriod, { at: number; body: string }>()
/** Forget the kept leaderboards (tests). */
export const resetScores = () => scoresCache.clear()

/**
 * GET /api/changes/scores?period=week|month|all: the leaderboard, one D1 query, kept for
 * SCORES_TTL in this isolate, so a busy page costs D1 little. Like every API answer, the browser
 * never stores it (withPrivateHeaders).
 */
async function scoreRoutes(url: URL, env: Env, now = Date.now()): Promise<Response> {
  const raw = url.searchParams.get("period") ?? "all"
  if (!SCORE_PERIODS.includes(raw as ScorePeriod))
    throw new HttpError(422, `period must be one of ${SCORE_PERIODS.join(", ")}`)
  const period = raw as ScorePeriod
  const headers = { "Content-Type": "application/json; charset=utf-8" }
  const kept = scoresCache.get(period)
  if (kept && now - kept.at < SCORES_TTL) return new Response(kept.body, { headers })
  const days = PERIOD_DAYS[period]
  const since = days === null ? 0 : now - days * DAY
  const { results } = await env.DB.prepare(SCORES_SQL).bind(since, BULK_FILES).all<ScoreRow>()
  const body = JSON.stringify({
    period,
    since: days === null ? null : since,
    generated_at: now,
    bulk_files: BULK_FILES,
    members: rankScores(results),
  })
  scoresCache.set(period, { at: now, body })
  return new Response(body, { headers })
}

/**
 * GET /api/changes: the newest changes first, `limit` at a time (PAGE, at most PAGE_MAX), and the
 * cursor of the next page (`before`). Filters: login (a member's contributions), repo, path (one
 * file), kind and state (comma lists). One D1 query.
 */
export async function changeRoutes(request: Request, url: URL, env: Env): Promise<Response | null> {
  if (url.pathname !== "/api/changes" && url.pathname !== "/api/changes/scores") return null
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method not allowed")
  if (url.pathname === "/api/changes/scores") return scoreRoutes(url, env)
  const query = url.searchParams
  const where: string[] = []
  const binds: (string | number)[] = []
  const login = query.get("login")?.trim()
  if (login) {
    where.push("login = ?")
    binds.push(login)
  }
  const repos = oneOf(query.get("repo"), REPOS, "repo")
  if (repos) {
    where.push(`repo IN (${repos.map(() => "?").join(", ")})`)
    binds.push(...repos)
  }
  const path = query.get("path")
  if (path) {
    where.push("path = ?")
    binds.push(path)
  }
  const kinds = oneOf(query.get("kind"), KINDS, "kind")
  if (kinds) {
    where.push(`kind IN (${kinds.map(() => "?").join(", ")})`)
    binds.push(...kinds)
  }
  const states = oneOf(query.get("state"), STATES, "state")
  if (states) {
    where.push(`state IN (${states.map(() => "?").join(", ")})`)
    binds.push(...states)
  }
  const before = query.get("before")
  if (before) {
    const cursor = /^(\d{1,15})\.(\d{1,15})$/.exec(before)
    if (!cursor) throw new HttpError(422, "before must be a cursor from an earlier page")
    where.push("(at < ? OR (at = ? AND id < ?))")
    binds.push(Number(cursor[1]), Number(cursor[1]), Number(cursor[2]))
  }
  const asked = Number(query.get("limit") ?? PAGE)
  const limit = Number.isInteger(asked) ? Math.min(Math.max(asked, 1), PAGE_MAX) : PAGE
  const { results } = await env.DB.prepare(
    `SELECT * FROM changes ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY at DESC, id DESC LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<ChangeRow>()
  const rows = results.slice(0, limit)
  const last = rows.at(-1)
  return json({
    changes: rows.map((row) => changeView(env, row)),
    next: results.length > limit && last ? `${last.at}.${last.id}` : null,
  })
}
