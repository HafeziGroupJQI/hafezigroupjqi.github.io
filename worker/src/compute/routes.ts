import { requireMutation } from "../auth"
import { hashSecret } from "../devices/keys"
import type { Env } from "../env"
import { HttpError, decodeSegment, json, readJson, withPrivateHeaders } from "../http"
import { type Session, bearer, timingSafeEqual } from "../session"
import { authorizeTarget } from "./policy"
import { type ControlRequest, MAX_BODY, type OpenMeta, RELAY_BUSY, RELAY_NAME } from "./relay"
import { audit, type Auditor } from "../audit"
import { issueAssertion, issueLabTicket, verifyLabTicket } from "./tokens"

// The Scratchpad's compute API. Three kinds of caller:
//   the compute host   GET /api/compute/host (WebSocket, bearer host key; machine route, no CORS)
//   the lab origin     /lab/<ticket>/jupyter/user/<login>/… on the Worker's own origin (labRoute):
//                      JupyterLab loaded straight from here, never from the site, so code running in
//                      a lab can't reach the members token; the ticket in the path is its only key
//   the /scratchpad page  status, start/stop, the owner's server list, Wolfram runs and forks.
// Everything funnels into the single ComputeRelay DO (relay.ts).

const PREFIX = "/api/compute"

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
// Upstream response headers that never reach the browser: cookies, CORS, the framing policy (the
// Worker sets its own), and anything that would widen a service worker's scope.
const DROP_RESPONSE_HEADERS =
  /^(?:set-cookie|content-security-policy|x-frame-options|access-control-.*|location|strict-transport-security|service-worker-allowed)$/
export const labCsp = (siteOrigin: string) =>
  `frame-ancestors 'self' ${siteOrigin}; object-src 'none'; base-uri 'self'`
const REDIRECTS = new Set([301, 302, 303, 307, 308])

const relay = (env: Env) => env.COMPUTE_RELAY.get(env.COMPUTE_RELAY.idFromName(RELAY_NAME))

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

// ---- the lab origin: JupyterLab served by the Worker itself (ticket in the path) ----

// How long a lab read waits for a free relay stream, and how often it looks.
const BUSY_WAIT_MS = 60_000
const BUSY_POLL_MS = 100
const LAB_PATH = /^\/lab\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(\/jupyter\/user\/.*)$/

/** Paths the lab origin answers (everything else on the Worker is the API or a redirect). */
export const isLabPath = (path: string) =>
  path.startsWith("/lab/") || path.startsWith("/jupyter/user/")

/** The lab URL base for `target`'s server, as `viewer` may open it. */
export async function labBase(
  env: Env,
  url: URL,
  viewer: Pick<Session, "login" | "role"> & { exp?: number },
  target: string,
): Promise<string> {
  const ticket = await issueLabTicket(env, viewer, target)
  return `${url.origin}/lab/${ticket}/jupyter/user/${encodeURIComponent(target.toLowerCase())}/`
}

/** The ticket of the lab page a same-origin request came from (its Referer), if any. */
function refererTicket(request: Request, url: URL): string | null {
  try {
    const referer = new URL(request.headers.get("referer") ?? "")
    if (referer.origin !== url.origin) return null
    return referer.pathname.match(LAB_PATH)?.[1] ?? null
  } catch {
    return null
  }
}

export async function labRoute(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const match = url.pathname.match(LAB_PATH)
  const token = match ? match[1] : refererTicket(request, url)
  const raw = (match ? match[2] : url.pathname) + url.search
  if (!match && !url.pathname.startsWith("/jupyter/user/")) {
    // The lab origin serves members' servers and nothing else (never the Hub).
    if (url.pathname.startsWith("/lab/"))
      throw new HttpError(403, "only a member's server is reachable on the lab origin")
    return null
  }
  // Member code on this origin could otherwise install a worker that watches other labs' requests.
  if (request.headers.get("service-worker"))
    throw new HttpError(403, "service workers are not allowed on the lab origin")
  const ticket = await verifyLabTicket(env, token)
  if (!ticket) {
    // An old or foreign link: send a person back to the Scratchpad to open the lab again.
    if (request.headers.get("sec-fetch-mode") === "navigate")
      return Response.redirect(new URL("/scratchpad", env.PUBLIC_SITE_URL).toString(), 302)
    throw new HttpError(401, "this lab link has expired; open the lab again from the Scratchpad")
  }
  const { target, login, crossUser } = authorizeTarget(raw, ticket, env)
  if (login !== ticket.target) throw new HttpError(403, "this lab link is for another server")
  const prefix = `/lab/${token}`
  const siteOrigin = new URL(env.PUBLIC_SITE_URL).origin
  const base = {
    target,
    assertion: await issueAssertion(env, ticket),
    ws_url: `${url.protocol === "http:" ? "ws:" : "wss:"}//${url.host}${prefix}`,
    // The page's own paths carry the ticket, so JupyterLab needs no ?token= of its own.
    ticket: "",
    login: ticket.login,
    base_prefix: prefix,
    site_origin: siteOrigin,
  }

  if (request.headers.get("upgrade") === "websocket") {
    // A WebSocket is not subject to CORS, so the Origin check is the cross-site guard.
    if (request.headers.get("origin") !== url.origin)
      throw new HttpError(403, "request from an unknown origin")
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
    const meta: OpenMeta = { ...base, method: "GET", headers: [], protocols }
    return relay(env).fetch("https://relay/ws", {
      headers: { upgrade: "websocket", "x-relay-meta": encodeURIComponent(JSON.stringify(meta)) },
    })
  }

  const method = request.method.toUpperCase()
  if (!METHODS.has(method)) throw new HttpError(405, "method not allowed")
  // An owner opening another member's lab: one row per page load, not per request.
  if (crossUser && /^\/jupyter\/user\/[^/]+\/lab\/?(?:\?|$)/.test(target))
    audit(env, ctx, request, {
      login: ticket.login,
      role: ticket.role,
      action: "compute.access_other",
      target: login,
      detail: null,
    })
  const length = Number(request.headers.get("content-length") ?? "0")
  if (length > MAX_BODY) throw new HttpError(413, "request body over 95 MiB")
  const headers: [string, string][] = []
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value) headers.push([name, value])
  }
  const hasBody = method !== "GET" && method !== "HEAD" && request.body != null
  const meta: OpenMeta = { ...base, method, headers, has_body: hasBody }
  const open = () =>
    relay(env).fetch("https://relay/http", {
      method: "POST",
      redirect: "manual",
      headers: { "x-relay-meta": encodeURIComponent(JSON.stringify(meta)) },
      body: hasBody ? request.body : null,
    })
  // A cold lab load asks for a hundred files at once, more streams than a member or the host may
  // have open, and a page never retries a script that failed: reads wait for a free stream.
  let upstream = await open()
  for (let waited = 0; !hasBody && upstream.headers.get(RELAY_BUSY) && waited < BUSY_WAIT_MS;) {
    await upstream.body?.cancel()
    await new Promise((resolve) => setTimeout(resolve, BUSY_POLL_MS))
    waited += BUSY_POLL_MS
    upstream = await open()
  }
  return finish(upstream, target, { prefix, siteOrigin })
}

// ---- member routes ----

/** Wolfram licence activations a member may try in an hour (each signs in to Wolfram). */
const ACTIVATIONS_PER_HOUR = 5

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
        // Where this member's lab lives: the Worker's origin, keyed by a ticket for their server.
        lab: await labBase(env, url, session, session.login),
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
      // Progress streams as NDJSON, then the final line.
      return control(
        env,
        session,
        "ensure_server",
        { profile },
        { stream: true, timeout_ms: 300_000 },
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
    const answer = await control(env, session, "list", {}, { timeout_ms: 15_000 })
    if (!answer.ok || env.COMPUTE_OWNER_ACCESS !== "true") return answer
    // Each row's lab, on the lab origin with a ticket for that one server.
    const listing = (await answer.json()) as { servers?: { login?: unknown }[] }
    for (const row of listing.servers ?? [])
      if (typeof row.login === "string" && /^[a-z0-9-]{1,39}$/.test(row.login))
        Object.assign(row, { lab_url: `${await labBase(env, url, session, row.login)}lab` })
    return withPrivateHeaders(json(listing))
  }

  // An owner stopping a member's server: both switches must be on, this one and the host's.
  const other = route.match(/^\/servers\/([^/]+)$/)
  if (other) {
    if (method !== "DELETE") throw new HttpError(405, "method not allowed")
    requireMutation(request, env)
    requireOwner(session)
    if (env.COMPUTE_OWNER_ACCESS !== "true") throw new HttpError(403, "owner access is off")
    const login = decodeSegment(other[1]).toLowerCase()
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
    // The run crosses the tunnel in one frame of at most 256 KiB, so count bytes, not characters:
    // an oversize frame failed as "compute host offline".
    if (new TextEncoder().encode(JSON.stringify({ code: body.code, prelude })).byteLength > 200_000)
      throw new HttpError(413, "this cell and the page's definitions before it are too long to run")
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

  // The member's own Wolfram Engine licence on the compute host (hafezi_compute/wolfram/licences.py):
  // its state, activating it with their Wolfram ID and password (used once there, never kept, and
  // never logged here), and removing it.
  if (route === "/wolfram/licence") {
    if (method === "GET")
      return control(env, session, "wolfram_licence", { action: "status" }, { timeout_ms: 30_000 })
    requireMutation(request, env)
    if (method === "DELETE") {
      record("compute.wolfram_licence", "remove")
      return control(env, session, "wolfram_licence", { action: "remove" }, { timeout_ms: 60_000 })
    }
    if (method !== "POST") throw new HttpError(405, "method not allowed")
    const body = (await readJson(request)) as { wolfram_id?: unknown; password?: unknown }
    const wolframId = typeof body.wolfram_id === "string" ? body.wolfram_id.trim() : ""
    const password = typeof body.password === "string" ? body.password : ""
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wolframId) || wolframId.length > 254)
      throw new HttpError(
        422,
        "enter your Wolfram ID: the email address you sign in to Wolfram with",
      )
    if (!password || password.length > 256)
      throw new HttpError(422, "enter your Wolfram account's password")
    const recent = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE login = ? AND action = 'compute.wolfram_licence'
         AND target = 'activate' AND at > ?`,
    )
      .bind(session.login, Date.now() - 3600_000)
      .first<{ n: number }>()
    if ((recent?.n ?? 0) >= ACTIVATIONS_PER_HOUR)
      throw new HttpError(429, "too many activation attempts; try again in an hour")
    record("compute.wolfram_licence", "activate")
    return control(
      env,
      session,
      "wolfram_licence",
      { action: "activate", wolfram_id: wolframId, password },
      { timeout_ms: 150_000 },
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

/** How a lab-origin answer differs: framed by the site, links keep the ticket prefix. */
export interface LabFinish {
  /** /lab/<ticket>, which a redirect to this member's server keeps. */
  prefix: string
  /** The members site, the only page allowed to frame the lab. */
  siteOrigin: string
}

/** Make an upstream answer safe to serve from the lab origin. */
export function finish(upstream: Response, target: string, lab: LabFinish): Response {
  const headers = new Headers()
  for (const [name, value] of upstream.headers)
    if (!DROP_RESPONSE_HEADERS.test(name)) headers.append(name, value)

  // A redirect to this member's server keeps the lab's ticket prefix.
  const location = upstream.headers.get("location")
  if (REDIRECTS.has(upstream.status) && location) {
    const next = new URL(location, new URL(target, "https://compute.invalid"))
    const path = next.pathname + next.search + next.hash
    headers.set("location", next.pathname.startsWith("/jupyter/user/") ? lab.prefix + path : path)
  }
  // Jupyter sandboxes the files it serves raw (/files/), so a member's HTML or SVG runs in an opaque
  // origin rather than as the site: keep that directive alongside the forced framing policy.
  const sandbox = (upstream.headers.get("content-security-policy") ?? "")
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => /^sandbox\b/i.test(directive))
  const csp = labCsp(lab.siteOrigin)
  headers.set("content-security-policy", sandbox ? `${csp}; ${sandbox}` : csp)
  // X-Frame-Options can't name another origin, so the lab relies on frame-ancestors alone.
  headers.set("x-content-type-options", "nosniff")
  headers.set("x-robots-tag", "noindex, nofollow, noarchive")
  // The lab's same-origin requests carry the page URL, whose ticket prefix vouches for the few paths
  // JupyterLab builds without it; nothing is ever sent to another origin.
  headers.set("referrer-policy", "same-origin")
  // Jupyter's own caching (hashed static files, etags) survives, but only in the member's browser.
  const cache = headers.get("cache-control")
  headers.set(
    "cache-control",
    cache ? cache.replace(/\bpublic\b/gi, "private") : "private, no-store",
  )
  if (!/\bprivate\b|no-store/i.test(headers.get("cache-control")!))
    headers.set("cache-control", `private, ${headers.get("cache-control")}`)
  return new Response(upstream.body, { status: upstream.status, headers })
}
