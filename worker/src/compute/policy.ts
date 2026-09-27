import type { Env } from "../env"
import { HttpError } from "../http"

// Which JupyterHub paths a member may reach through the relay. Only their own single-user server
// (/jupyter/user/<login>/…) is reachable; the Hub UI and API (/jupyter/hub/*) never are, because
// the Worker, not the Hub, decides who is signed in. The host re-checks the login against the
// assertion, so this is the first of two gates, not the only one.

const USER_PATH = /^\/jupyter\/user\/([a-z0-9-]+)\//
// Encoded separators would let one path mean two things to the Worker and to Tornado.
const ENCODED_SEPARATOR = /%2f|%5c/i

export interface Authorized {
  /** What goes into OPEN_HTTP / OPEN_WS: the path exactly as the browser sent it, plus the query. */
  target: string
  /** The server's owner (the path login). */
  login: string
  /** True when an owner is reaching another member's server (COMPUTE_OWNER_ACCESS). */
  crossUser: boolean
}

export function authorizeTarget(
  raw: string,
  principal: { login: string; role: "member" | "owner" },
  env: Env,
): Authorized {
  if (!raw.startsWith("/") || raw.startsWith("//")) throw new HttpError(400, "bad compute target")
  const cut = raw.indexOf("?")
  const path = cut === -1 ? raw : raw.slice(0, cut)
  const query = cut === -1 ? "" : raw.slice(cut)
  if (ENCODED_SEPARATOR.test(path)) throw new HttpError(400, "encoded path separators are refused")

  // Decode exactly once, then judge the decoded path.
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    throw new HttpError(400, "bad compute target")
  }
  if (/[\\\0]/.test(decoded) || decoded.split("/").some((segment) => segment === ".."))
    throw new HttpError(400, "bad compute target")
  if (decoded === "/jupyter/hub" || decoded.startsWith("/jupyter/hub/"))
    throw new HttpError(403, "the hub is not reachable from the site")

  const match = decoded.match(USER_PATH)
  if (!match) throw new HttpError(403, "only your own compute server is reachable")
  const login = match[1]
  const self = principal.login.toLowerCase()
  if (login === self) return { target: path + query, login, crossUser: false }
  if (principal.role === "owner" && env.COMPUTE_OWNER_ACCESS === "true") {
    // No audit table on this branch yet: the structured log line is the audit trail.
    console.log(JSON.stringify({ audit: "compute.owner_access", actor: self, login, path }))
    return { target: path + query, login, crossUser: true }
  }
  throw new HttpError(403, "only your own compute server is reachable")
}
