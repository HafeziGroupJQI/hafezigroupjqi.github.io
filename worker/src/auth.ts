import { audit } from "./audit"
import type { Env } from "./env"
import { HttpError, json, readJson } from "./http"
import { issueSession, randomToken, sign, timingSafeEqual, verify } from "./session"

// Sign-in for the github.io site. The browser never visits the Worker:
//   1. /auth/login (a static github.io page) POSTs /api/auth/start and gets GitHub's authorize URL,
//      whose redirect_uri is PUBLIC_SITE_URL/auth/callback and whose `state` is a Worker-signed,
//      10-minute token bound to a nonce the page keeps in sessionStorage.
//   2. GitHub returns to /auth/callback (another static page), which POSTs {code, state, nonce}
//      to /api/auth/exchange. The Worker checks the state, trades the code with the client secret,
//      applies the org/team rule and returns an 8 h bearer token.

const GITHUB_API = "https://api.github.com"
const USER_AGENT = "hafezi-members-worker"
const STATE_TTL = 600

/** Outbound fetch to GitHub (OAuth + REST); tests substitute a stub. */
export type GitHubFetch = (input: string, init: RequestInit) => Promise<Response>

interface Membership {
  state?: string
  role?: string
}

interface PendingLogin {
  typ: "state"
  nonce: string
  next: string
  exp: number
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

export const callbackUrl = (env: Env) => `${new URL(env.PUBLIC_SITE_URL).origin}/auth/callback`

const str = (value: unknown) => (typeof value === "string" ? value : "")

export async function startLogin(request: Request, env: Env): Promise<Response> {
  const body = (await readJson(request)) as { next?: unknown }
  const next = safeNext(str(body.next))
  const nonce = randomToken()
  if (env.AUTH_MODE === "dev") {
    const state = await sign(
      { typ: "state", nonce, next, exp: Math.floor(Date.now() / 1000) + STATE_TTL },
      env.SESSION_SECRET,
    )
    return json({ dev: true, state, nonce, next })
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET)
    throw new HttpError(503, "GitHub login is not configured")
  const pending: PendingLogin = {
    typ: "state",
    nonce,
    next,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL,
  }
  const state = await sign(pending, env.SESSION_SECRET)
  const authorize = new URL("https://github.com/login/oauth/authorize")
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID)
  authorize.searchParams.set("redirect_uri", callbackUrl(env))
  authorize.searchParams.set("scope", "read:org")
  authorize.searchParams.set("state", state)
  return json({ authorize_url: authorize.toString(), nonce })
}

export async function exchange(
  request: Request,
  env: Env,
  githubFetch: GitHubFetch,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = (await readJson(request)) as { code?: unknown; state?: unknown; nonce?: unknown }
  const pending = await verify<PendingLogin>(str(body.state), env.SESSION_SECRET, "state")
  if (!pending || !timingSafeEqual(pending.nonce, str(body.nonce)))
    throw new HttpError(400, "login attempt expired; start again")

  if (env.AUTH_MODE === "dev") {
    const user = { login: "dev", name: "Local member", role: "owner" as const }
    audit(env, ctx, request, {
      login: user.login,
      role: user.role,
      action: "auth.login",
      status: 200,
    })
    return json({ ...(await issueSession(user, env)), user, next: pending.next })
  }

  const code = str(body.code)
  if (!code) throw new HttpError(400, "missing authorization code")
  const exchanged = await githubFetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(env),
    }),
  })
  const token = exchanged.ok
    ? ((await exchanged.json()) as { access_token?: string }).access_token
    : null
  if (!token) throw new HttpError(502, "GitHub did not issue a token")
  const github = (path: string) =>
    githubFetch(GITHUB_API + path, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": USER_AGENT,
      },
    })
  const userResponse = await github("/user")
  if (!userResponse.ok) throw new HttpError(502, "GitHub did not identify the user")
  const profile = (await userResponse.json()) as { login: string; name?: string | null }
  const [org, team] = await Promise.all([
    github(`/user/memberships/orgs/${env.GITHUB_ORG}`),
    github(`/orgs/${env.GITHUB_ORG}/teams/${env.GITHUB_TEAM}/memberships/${profile.login}`),
  ])
  const [allowed, role] = decide(
    org.ok ? ((await org.json()) as Membership) : null,
    team.ok ? ((await team.json()) as Membership) : null,
  )
  // GitHub logins are case-insensitive: the site keeps them lowercase everywhere (the lab's
  // tickets, D1's owner columns), and GitHub's casing only as the default display name.
  const login = profile.login.toLowerCase()
  if (!allowed) {
    audit(env, ctx, request, {
      login,
      action: "auth.denied",
      status: 403,
      detail: { reason: role },
    })
    throw new HttpError(403, `${profile.login}: ${role}`)
  }
  const user = { login, name: profile.name ?? profile.login, role }
  audit(env, ctx, request, { login: user.login, role, action: "auth.login", status: 200 })
  return json({ ...(await issueSession(user, env)), user, next: pending.next })
}

/** Allowed browser origins: the github.io site plus any ALLOWED_ORIGINS (local development). */
export function allowedOrigins(env: Env): Set<string> {
  const origins = new Set([new URL(env.PUBLIC_SITE_URL).origin])
  for (const entry of (env.ALLOWED_ORIGINS ?? "").split(","))
    if (entry.trim()) origins.add(entry.trim().replace(/\/$/, ""))
  return origins
}

// Bearer tokens are never sent ambiently, so there is no CSRF to guard against; a write that does
// come from a browser must still come from one of the site's own origins.
export function requireMutation(request: Request, env: Env): void {
  const origin = request.headers.get("origin")
  if (origin && !allowedOrigins(env).has(origin))
    throw new HttpError(403, "request from an unknown origin")
}
