import type { Env } from "./env"
import { HttpError, cookies, problem, redirect } from "./http"
import {
  SESSION_COOKIE,
  type Session,
  clearCookie,
  randomToken,
  serializeCookie,
  sessionCookie,
  sign,
  timingSafeEqual,
  verify,
} from "./session"

const OAUTH_COOKIE = "hafezi_oauth"
const GITHUB_API = "https://api.github.com"
const USER_AGENT = "hafezi-members-worker"

interface Membership {
  state?: string
  role?: string
}

// Org owners always get in; otherwise the visitor must be an active member of the lab team.
export function decide(
  org: Membership | null,
  team: Membership | null,
): [true, "owner" | "member"] | [false, string] {
  if (org && org.state === "active" && org.role === "admin") return [true, "owner"]
  if (team && team.state === "active") return [true, "member"]
  return [false, "not a member of the lab team"]
}

// Only same-site paths may be used as a post-login destination.
export function safeNext(value: string | null | undefined, fallback = "/"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return fallback
  if (/^\/[^/]*:/.test(value)) return fallback
  for (const char of value) if (char.charCodeAt(0) < 32) return fallback
  try {
    const parsed = new URL(value, "https://placeholder.invalid")
    if (parsed.origin !== "https://placeholder.invalid") return fallback
  } catch {
    return fallback
  }
  return value
}

export const loginUrl = (url: URL) =>
  `/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`

const github = async (path: string, token: string) =>
  fetch(GITHUB_API + path, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": USER_AGENT,
    },
  })

export async function login(request: Request, url: URL, env: Env): Promise<Response> {
  const next = safeNext(url.searchParams.get("next"))
  if (env.AUTH_MODE === "dev") {
    const cookie = await sessionCookie({ login: "dev", name: "Local member", role: "owner" }, url, env)
    return redirect(next, 302, { "set-cookie": cookie })
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET)
    return problem(503, "GitHub login is not configured")
  const state = randomToken()
  const pending = await sign({ state, next, exp: Math.floor(Date.now() / 1000) + 600 }, env.SESSION_SECRET)
  const authorize = new URL("https://github.com/login/oauth/authorize")
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID)
  authorize.searchParams.set("redirect_uri", `${url.origin}/auth/callback`)
  authorize.searchParams.set("scope", "read:org")
  authorize.searchParams.set("state", state)
  return redirect(authorize.toString(), 302, {
    "set-cookie": serializeCookie(OAUTH_COOKIE, pending, url, 600),
  })
}

export async function callback(request: Request, url: URL, env: Env): Promise<Response> {
  if (env.AUTH_MODE !== "github") return problem(404, "not found")
  const pending = await verify<{ state: string; next: string; exp: number }>(
    cookies(request).get(OAUTH_COOKIE),
    env.SESSION_SECRET,
  )
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  if (!pending || !code || !state || !timingSafeEqual(state, pending.state))
    return problem(400, "login attempt expired; start again")
  const exchange = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  })
  const token = exchange.ok ? ((await exchange.json()) as { access_token?: string }).access_token : null
  if (!token) return problem(502, "GitHub did not issue a token")
  const userResponse = await github("/user", token)
  if (!userResponse.ok) return problem(502, "GitHub did not identify the user")
  const user = (await userResponse.json()) as { login: string; name?: string | null }
  const [org, team] = await Promise.all([
    github(`/user/memberships/orgs/${env.GITHUB_ORG}`, token),
    github(`/orgs/${env.GITHUB_ORG}/teams/${env.GITHUB_TEAM}/memberships/${user.login}`, token),
  ])
  const [allowed, role] = decide(
    org.ok ? ((await org.json()) as Membership) : null,
    team.ok ? ((await team.json()) as Membership) : null,
  )
  const clear = clearCookie(OAUTH_COOKIE, url)
  if (!allowed)
    return new Response(`${user.login}: ${role}`, {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8", "set-cookie": clear },
    })
  const cookie = await sessionCookie({ login: user.login, name: user.name ?? user.login, role }, url, env)
  const headers = new Headers({ location: safeNext(pending.next) })
  headers.append("set-cookie", cookie)
  headers.append("set-cookie", clear)
  return new Response(null, { status: 302, headers })
}

export function logout(url: URL, env: Env): Response {
  return redirect(env.PUBLIC_SITE_URL, 302, {
    "set-cookie": clearCookie(SESSION_COOKIE, url),
    "clear-site-data": '"cache", "storage"',
  })
}

// Cookie authentication needs a same-origin request and the session's CSRF token.
export function requireMutation(request: Request, url: URL, session: Session): void {
  if (request.headers.get("origin") !== url.origin)
    throw new HttpError(403, "same-origin request required")
  const supplied = request.headers.get("x-csrf-token") ?? ""
  if (!session.csrf || !timingSafeEqual(session.csrf, supplied))
    throw new HttpError(403, "invalid CSRF token")
}
