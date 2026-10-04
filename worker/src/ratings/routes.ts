import type { Auditor } from "../audit"
import { requireMutation } from "../auth"
import type { Env } from "../env"
import { HttpError, json, readJson } from "../http"
import type { Session } from "../session"
import { underLimit } from "../uploads/routes"
import { readablePage } from "./access"
import { isoDay, pagePath } from "./views"

// A page's rating, like a reddit post's: each member's up or down vote (D1 page_votes, migration
// 0019), shown as ▲ score ▼ in the page's tools row (frontend/ratings/), with how many members have
// read it (page_views, views.ts). GET /api/ratings?path= answers a page's; PUT /api/ratings
// {path, value: 1 | -1 | 0} sets or (0) takes back the member's own vote and answers the page's new
// rating. A path that is not a page the member can read is a 404, as if it weren't there.

/** Votes (each change of one) a member may cast in 24 hours. */
export const VOTES_PER_DAY = 300

export interface Rating {
  path: string
  /** Up votes less down votes. */
  score: number
  up: number
  down: number
  /** The member's own vote: 1, -1, or 0 for none. */
  mine: number
  /** Members who ever opened the page, and those who did in the last 7 days. */
  viewers: number
  views7: number
}

const RATING_SQL = `
  SELECT COALESCE(SUM(value = 1), 0) AS up,
         COALESCE(SUM(value = -1), 0) AS down,
         (SELECT value FROM page_votes WHERE path = ?1 AND login = ?2) AS mine,
         (SELECT COUNT(DISTINCT login) FROM page_views WHERE path = ?1) AS viewers,
         (SELECT COUNT(DISTINCT login) FROM page_views WHERE path = ?1 AND day >= ?3) AS views7
  FROM page_votes WHERE path = ?1`

function ratingStatement(env: Env, path: string, login: string, now: number) {
  return env.DB.prepare(RATING_SQL).bind(path, login, isoDay(now - 6 * 86_400_000))
}

function ratingOf(path: string, row: Omit<Rating, "path" | "score"> | null): Rating {
  const up = row?.up ?? 0
  const down = row?.down ?? 0
  return {
    path,
    score: up - down,
    up,
    down,
    mine: row?.mine ?? 0,
    viewers: row?.viewers ?? 0,
    views7: row?.views7 ?? 0,
  }
}

/** Whether the members build has `path` as a whole HTML page (following its trailing-slash hop). */
async function isPage(env: Env, origin: string, path: string): Promise<boolean> {
  let url = new URL(
    path === "index" ? "/" : `/${path.split("/").map(encodeURIComponent).join("/")}`,
    origin,
  )
  for (let hop = 0; hop < 3; hop++) {
    const response = await env.ASSETS.fetch(
      new Request(url, { method: "HEAD", redirect: "manual" }),
    )
    const location = response.headers.get("location")
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url)
      continue
    }
    return (
      response.status === 200 && !!response.headers.get("content-type")?.startsWith("text/html")
    )
  }
  return false
}

/** The page a request names, if the member may rate it: else a 404, whatever the reason. */
async function ratedPage(
  env: Env,
  url: URL,
  session: Session,
  raw: unknown,
  toolPages: readonly string[],
): Promise<string> {
  if (typeof raw !== "string" || !raw.trim()) throw new HttpError(422, "path must name a page")
  const path = pagePath(raw.trim())
  if (
    !path ||
    toolPages.includes(`/${path}`) ||
    !(await isPage(env, url.origin, path)) ||
    !(await readablePage(env, session, path))
  )
    throw new HttpError(404, "no such page")
  return path
}

export async function ratingRoutes(
  request: Request,
  url: URL,
  env: Env,
  session: Session,
  record: Auditor,
  toolPages: readonly string[],
  now = Date.now(),
): Promise<Response | null> {
  if (url.pathname !== "/api/ratings") return null
  if (request.method === "GET" || request.method === "HEAD") {
    const path = await ratedPage(env, url, session, url.searchParams.get("path"), toolPages)
    return json(ratingOf(path, await ratingStatement(env, path, session.login, now).first()))
  }
  if (request.method !== "PUT") throw new HttpError(405, "method not allowed")
  requireMutation(request, env)
  const body = (await readJson(request)) as Record<string, unknown>
  const value = body.value
  if (value !== 1 && value !== -1 && value !== 0)
    throw new HttpError(422, "value must be 1 (up), -1 (down) or 0 (no vote)")
  const path = await ratedPage(env, url, session, body.path, toolPages)
  await underLimit(env, session.login, ["rating.vote"], VOTES_PER_DAY, "votes")
  // One statement each, so two votes at once (two tabs, a double click) leave one row: the later.
  // Sending the vote the member already has keeps the time it was cast.
  const write =
    value === 0
      ? env.DB.prepare("DELETE FROM page_votes WHERE path = ? AND login = ?").bind(
          path,
          session.login,
        )
      : env.DB.prepare(
          `INSERT INTO page_votes (path, login, value, at) VALUES (?, ?, ?, ?)
           ON CONFLICT (path, login) DO UPDATE SET
             at = CASE WHEN value = excluded.value THEN at ELSE excluded.at END,
             value = excluded.value`,
        ).bind(path, session.login, value, now)
  const [, rating] = await env.DB.batch([write, ratingStatement(env, path, session.login, now)])
  record("rating.vote", path, { value })
  return json(ratingOf(path, (rating.results[0] ?? null) as Omit<Rating, "path" | "score"> | null))
}
