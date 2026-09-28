import type { Auditor } from "../audit"
import { allowedOrigins, requireMutation } from "../auth"
import { hashSecret } from "../devices/keys"
import type { Env } from "../env"
import { HttpError, json, readJson, withPrivateHeaders } from "../http"
import { type Session, bearer, timingSafeEqual } from "../session"
import { authorizeTarget } from "./policy"
import { type ControlRequest, MAX_BODY, type OpenMeta, RELAY_NAME } from "./relay"
import { issueAssertion, issueTicket, verifyTicket } from "./tokens"

// The Scratchpad's compute API. Three kinds of caller:
//   the compute host   GET /api/compute/host (WebSocket, bearer host key; machine route, no CORS)
//   JupyterLab         POST /api/compute/fetch (the service worker's envelope for every /jupyter/
//                      request) and /api/compute/ws/* (WebSockets straight to the Worker, ?token=
//                      ticket, since a browser WebSocket carries no bearer header)
//   the /scratchpad page  status, start/stop, the owner's server list, Wolfram runs and forks.
// Everything funnels into the single ComputeRelay DO (relay.ts).

const PREFIX = "/api/compute"
const WS_PREFIX = "/api/compute/ws"

export const PROFILES = [
  "base",
  "courses",
  "lumerical",
  "fdtd",
  "gds",
  "topological",
  "dispersion",
  "g2",
  "reservoir",
  "meep",
]

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
// Request headers JupyterLab needs upstream; each is also in the CORS allow-list (http.ts). Never
// cookie, authorization or x-forwarded-*: the host injects its own Hub token.
const FORWARD_REQUEST_HEADERS = ["accept", "content-type", "range", "if-none-match"]
// Upstream response headers that never reach the member: cookies, CORS (ours, not Jupyter's), and
// the framing policy, which the Worker forces.
const DROP_RESPONSE_HEADERS =
  /^(?:set-cookie|content-security-policy|x-frame-options|access-control-.*|location|strict-transport-security)$/
export const FORCED_CSP = "frame-ancestors 'self'; object-src 'none'; base-uri 'self'"
const REDIRECTS = new Set([301, 302, 303, 307, 308])

const relay = (env: Env) => env.COMPUTE_RELAY.get(env.COMPUTE_RELAY.idFromName(RELAY_NAME))

const wsUrl = (url: URL) => `${url.protocol === "http:" ? "ws:" : "wss:"}//${url.host}${WS_PREFIX}`

// ---- the host's socket (machine route) ----

export async function computeHostRoute(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response | null> {
  if (url.pathname !== `${PREFIX}/host`) return null
  if (!env.COMPUTE_HOST_KEY_HASH) throw new HttpError(503, "compute is not configured")
  const key = bearer(request)
  if (!key) throw new HttpError(401, "host key required")
  if (!timingSafeEqual(await hashSecret(key), env.COMPUTE_HOST_KEY_HASH.trim().toLowerCase()))
    throw new HttpError(401, "unknown host key")
  if (request.headers.get("upgrade") !== "websocket")
    throw new HttpError(426, "expected websocket upgrade")
  return relay(env).fetch("https://relay/host", request)
}

// ---- JupyterLab WebSockets (ticket, not session) ----

/** Remove the ?token= ticket from a raw query string without re-encoding the rest. */
export function stripToken(search: string): string {
  const kept = search
    .replace(/^\?/, "")
    .split("&")
    .filter((part) => part && !/^token(?:=|$)/.test(part))
  return kept.length ? `?${kept.join("&")}` : ""
}

export async function computeSocketRoute(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response | null> {
  if (!url.pathname.startsWith(WS_PREFIX + "/")) return null
  if (request.headers.get("upgrade") !== "websocket")
    throw new HttpError(426, "expected websocket upgrade")
  // A WebSocket is not subject to CORS, so the Origin check is the cross-site guard.
  const origin = request.headers.get("origin")
  if (!origin || !allowedOrigins(env).has(origin))
    throw new HttpError(403, "request from an unknown origin")
  const ticket = await verifyTicket(env, url.searchParams.get("token"))
  if (!ticket) throw new HttpError(401, "invalid or expired compute ticket")
  const raw = url.pathname.slice(WS_PREFIX.length) + stripToken(url.search)
  const { target, login } = authorizeTarget(raw, ticket, env)
  const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  const meta: OpenMeta = {
    method: "GET",
    target,
    headers: [],
    assertion: await issueAssertion(env, ticket),
    ws_url: wsUrl(url),
    ticket: url.searchParams.get("token") ?? "",
    login,
    protocols,
  }
  return relay(env).fetch("https://relay/ws", {
    headers: { upgrade: "websocket", "x-relay-meta": encodeURIComponent(JSON.stringify(meta)) },
  })
}

// ---- member routes ----

async function control(
  env: Env,
  session: Session,
  op: string,
  args: unknown,
  options: Partial<ControlRequest> = {},
): Promise<Response> {
  const body: ControlRequest = {
    op,
    args,
    assertion: await issueAssertion(env, session),
    login: session.login.toLowerCase(),
    ...options,
  }
  const response = await relay(env).fetch("https://relay/control", {
    method: "POST",
    body: JSON.stringify(body),
  })
  return withPrivateHeaders(response)
}

function requireOwner(session: Session): void {
  if (session.role !== "owner") throw new HttpError(403, "owner access required")
}

// Control actions (start, stop, fork, an owner opening another member's lab) are audited;
// the relayed JupyterLab traffic itself is not, since every request of it is a POST envelope.
export async function computeRoutes(
  request: Request,
  url: URL,
  env: Env,
  session: Session,
  record: Auditor,
): Promise<Response | null> {
  if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + "/")) return null
  const route = url.pathname.slice(PREFIX.length)
  const method = request.method

  if (route === "/fetch") {
    if (method !== "POST") throw new HttpError(405, "method not allowed")
    return envelope(request, url, env, session, record)
  }

  if (route === "/status") {
    if (method !== "GET") throw new HttpError(405, "method not allowed")
    const host = (await (await relay(env).fetch("https://relay/status")).json()) as {
      online: boolean
      host_id: string | null
      version: string | null
    }
    let server: unknown = null
    let error: string | null = null
    if (host.online) {
      const answer = await control(env, session, "status", {}, { timeout_ms: 10_000 })
      if (answer.ok) server = await answer.json()
      else error = ((await answer.json()) as { detail?: string }).detail ?? "status unavailable"
    }
    return withPrivateHeaders(
      json({
        host: { online: host.online, host_id: host.host_id, version: host.version },
        server,
        error,
        login: session.login.toLowerCase(),
        role: session.role,
        profiles: PROFILES,
        // Whether owners may open members' labs through the Worker (the host has its own switch).
        owner_access: session.role === "owner" && env.COMPUTE_OWNER_ACCESS === "true",
      }),
    )
  }

  if (route === "/server") {
    requireMutation(request, env)
    if (method === "POST") {
      const body = (
        request.headers.get("content-length") === "0" ? {} : await readJson(request)
      ) as {
        profile?: unknown
      }
      const profile = body?.profile ?? "base"
      if (typeof profile !== "string" || !PROFILES.includes(profile))
        throw new HttpError(422, "unknown profile")
      record("compute.start", session.login, { profile })
      // Progress streams as NDJSON; the final line carries the WebSocket ticket for the lab.
      return control(
        env,
        session,
        "ensure_server",
        { profile },
        {
          stream: true,
          timeout_ms: 300_000,
          extra: { ticket: await issueTicket(env, session), ws_url: wsUrl(url) },
        },
      )
    }
    if (method === "DELETE") {
      record("compute.stop", session.login)
      return control(env, session, "stop_server", {}, { timeout_ms: 60_000 })
    }
    throw new HttpError(405, "method not allowed")
  }

  if (route === "/servers") {
    if (method !== "GET") throw new HttpError(405, "method not allowed")
    requireOwner(session)
    return control(env, session, "list", {}, { timeout_ms: 15_000 })
  }

  // An owner stopping a member's server. The host also requires its owner access to be on.
  const other = route.match(/^\/servers\/([^/]+)$/)
  if (other) {
    if (method !== "DELETE") throw new HttpError(405, "method not allowed")
    requireMutation(request, env)
    requireOwner(session)
    const login = decodeURIComponent(other[1]).toLowerCase()
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(login)) throw new HttpError(422, "bad login")
    record("compute.stop", login)
    return control(env, session, "stop_server", { login }, { timeout_ms: 60_000 })
  }

  if (route === "/wolfram/run") {
    if (method !== "POST") throw new HttpError(405, "method not allowed")
    requireMutation(request, env)
    const body = (await readJson(request)) as {
      code?: unknown
      prelude?: unknown
      page?: unknown
    }
    if (typeof body.code !== "string" || !body.code.trim() || body.code.length > 20_000)
      throw new HttpError(422, "code must be a non-empty string under 20000 characters")
    const prelude = Array.isArray(body.prelude) ? body.prelude : []
    if (prelude.some((item) => typeof item !== "string") || prelude.join("").length > 100_000)
      throw new HttpError(422, "prelude must be a list of code strings")
    // The notebook page the cell is on (its path), for the host's logs.
    const page = typeof body.page === "string" ? body.page.slice(0, 512) : null
    // The optional COMPUTE_LIMIT binding is a coarse edge limit; the relay enforces the real
    // 1-concurrent + 30-per-10-minutes budget per login.
    if (env.COMPUTE_LIMIT) {
      const { success } = await env.COMPUTE_LIMIT.limit({ key: `wolfram:${session.login}` })
      if (!success) throw new HttpError(429, "Wolfram run limit reached")
    }
    return control(
      env,
      session,
      "wolfram_run",
      { code: body.code, prelude, page },
      {
        limit: "wolfram",
        timeout_ms: 45_000,
      },
    )
  }

  if (route === "/fork") {
    if (method !== "POST") throw new HttpError(405, "method not allowed")
    requireMutation(request, env)
    // A published notebook (a file of the private vault, which the host mirrors) copied into the
    // member's storage; the host answers with its path there.
    const body = (await readJson(request)) as { source?: { kind?: unknown; path?: unknown } }
    const kind = body.source?.kind
    const path = body.source?.path
    if (kind !== "published" || typeof path !== "string" || !path || path.length > 1024)
      throw new HttpError(422, "source must be {kind: published, path}")
    if (path.startsWith("/") || path.split("/").includes(".."))
      throw new HttpError(422, "bad source path")
    record("compute.fork", path, { kind })
    return control(env, session, "fork", { source: `published:${path}` }, { timeout_ms: 60_000 })
  }

  throw new HttpError(404, "not found")
}

// ---- the envelope: one URL for every JupyterLab request ----

async function envelope(
  request: Request,
  url: URL,
  env: Env,
  session: Session,
  record: Auditor,
): Promise<Response> {
  const method = (request.headers.get("x-compute-method") ?? "").toUpperCase()
  if (!METHODS.has(method)) throw new HttpError(400, "x-compute-method is missing or unsupported")
  const { target, login, crossUser } = authorizeTarget(
    request.headers.get("x-compute-target") ?? "",
    session,
    env,
  )
  // An owner opening another member's lab: one row per page load, not per request.
  if (crossUser && /^\/jupyter\/user\/[^/]+\/lab\/?(?:\?|$)/.test(target))
    record("compute.access_other", login)
  const length = Number(request.headers.get("content-length") ?? "0")
  if (length > MAX_BODY) throw new HttpError(413, "request body over 95 MiB")

  const headers: [string, string][] = []
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value) headers.push([name, value])
  }
  const hasBody = method !== "GET" && method !== "HEAD" && request.body != null
  const meta: OpenMeta = {
    method,
    target,
    headers,
    assertion: await issueAssertion(env, session),
    ws_url: wsUrl(url),
    ticket: await issueTicket(env, session),
    login: session.login.toLowerCase(),
    has_body: hasBody,
  }
  const upstream = await relay(env).fetch("https://relay/http", {
    method: "POST",
    redirect: "manual",
    headers: { "x-relay-meta": encodeURIComponent(JSON.stringify(meta)) },
    body: hasBody ? request.body : null,
  })
  return finish(upstream, target)
}

/** Make an upstream answer safe to hand back through the service worker. */
export function finish(upstream: Response, target: string): Response {
  const headers = new Headers()
  for (const [name, value] of upstream.headers)
    if (!DROP_RESPONSE_HEADERS.test(name)) headers.append(name, value)
  let status = upstream.status
  let body: ReadableStream | null = upstream.body

  // 401/403 upstream is Jupyter's refusal, not the member's session: a 401 would sign them out.
  if (status === 401 || status === 403) {
    headers.set("x-compute-upstream-status", String(status))
    status = 403
  }
  // Redirects cannot cross origins through the service worker: report the github.io path instead.
  if (REDIRECTS.has(status)) {
    const location = upstream.headers.get("location")
    if (location) {
      const next = new URL(location, new URL(target, "https://compute.invalid"))
      headers.set("x-compute-location", next.pathname + next.search + next.hash)
      headers.delete("content-length")
      status = 204
      upstream.body?.cancel().catch(() => {})
      body = null
    }
  }
  // Jupyter sandboxes the files it serves raw (/files/), so a member's HTML or SVG runs in an opaque
  // origin rather than as the site: keep that directive alongside the forced framing policy.
  const sandbox = (upstream.headers.get("content-security-policy") ?? "")
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => /^sandbox\b/i.test(directive))
  headers.set("content-security-policy", sandbox ? `${FORCED_CSP}; ${sandbox}` : FORCED_CSP)
  headers.set("x-frame-options", "SAMEORIGIN")
  headers.set("vary", "Origin, Authorization")
  headers.set("x-content-type-options", "nosniff")
  headers.set("x-robots-tag", "noindex, nofollow, noarchive")
  headers.set("referrer-policy", "no-referrer")
  // Jupyter's own caching (hashed static files, etags) survives, but only in the member's browser.
  const cache = headers.get("cache-control")
  headers.set(
    "cache-control",
    cache ? cache.replace(/\bpublic\b/gi, "private") : "private, no-store",
  )
  if (!/\bprivate\b|no-store/i.test(headers.get("cache-control")!))
    headers.set("cache-control", `private, ${headers.get("cache-control")}`)
  return new Response(body, { status, headers })
}
