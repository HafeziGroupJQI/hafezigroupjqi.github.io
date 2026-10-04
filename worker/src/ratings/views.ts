import type { Env } from "../env"

// Which member opened which page on which day (D1 page_views, migration 0019): the readers behind a
// page's popularity and its contributors' reach on /leaderboard. site() (app.ts) records a view
// for every page it serves whole, after answering (waitUntil), so a page never waits for it. A
// member's day on a page is one row however often they open it, and an isolate remembers what it
// wrote, so reloading a page costs D1 nothing.

/** The longest page path kept. */
const PATH_MAX = 512

/**
 * A page as ratings and views key it, from its path on the site: no leading or trailing slash, no
 * ".html", no trailing "index" ("/resources/notes/" and "/resources/notes/index.html" are
 * "resources/notes"); the home page is "index". The changes table's slug becomes the same form
 * (creditSql in leaderboard.ts). Null for a path that can't be a page.
 */
export function pagePath(sitePath: string): string | null {
  let path = sitePath
  try {
    path = decodeURIComponent(sitePath)
  } catch {
    return null
  }
  path = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.html$/, "")
    .replace(/(^|\/)index$/, "")
    .replace(/\/+$/, "")
  if (!path) return "index"
  if (path.length > PATH_MAX || /[\0-\x1f\x7f\\]/.test(path)) return null
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) return null
  return path
}

/** A day as page_views keeps it: the UTC date, YYYY-MM-DD. */
export const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10)

/** Probe sessions (admins' read-only stand-ins for testing access) are never anyone's reader. */
export const isProbe = (login: string) => login.toLowerCase().startsWith("probe-")

// What this isolate has written today: a member's reloads go no further.
const written = new Set<string>()
const WRITTEN_MAX = 5000
/** Forget what was written (tests). */
export const resetViews = () => written.clear()

/** Record that `login` opened `path` today, after the response (never failing it). */
export function recordView(
  env: Pick<Env, "DB">,
  ctx: ExecutionContext,
  login: string,
  path: string,
  now = Date.now(),
): void {
  if (isProbe(login)) return
  const day = isoDay(now)
  const key = `${day}\n${login.toLowerCase()}\n${path}`
  if (written.has(key)) return
  if (written.size >= WRITTEN_MAX) written.clear()
  written.add(key)
  ctx.waitUntil(
    env.DB.prepare("INSERT OR IGNORE INTO page_views (path, login, day) VALUES (?, ?, ?)")
      .bind(path, login, day)
      .run()
      .catch((error) => {
        written.delete(key)
        console.error("page view not recorded", error)
      }),
  )
}

/**
 * The page a response of site() is, if it is one a member reads: a whole HTML page (not an asset,
 * a byte range or a 404), and not one of the site's tool pages (`toolPages`, as "/recent").
 */
export function viewedPage(
  sitePath: string,
  method: string,
  response: Response,
  toolPages: readonly string[],
): string | null {
  if (method !== "GET" || response.status !== 200) return null
  if (!response.headers.get("content-type")?.startsWith("text/html")) return null
  const path = pagePath(sitePath)
  if (!path || toolPages.includes(`/${path}`)) return null
  return path
}
