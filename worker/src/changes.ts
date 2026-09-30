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

/**
 * GET /api/changes: the newest changes first, `limit` at a time (PAGE, at most PAGE_MAX), and the
 * cursor of the next page (`before`). Filters: login (a member's contributions), repo, path (one
 * file), kind and state (comma lists). One D1 query.
 */
export async function changeRoutes(request: Request, url: URL, env: Env): Promise<Response | null> {
  if (url.pathname !== "/api/changes") return null
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method not allowed")
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
