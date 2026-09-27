import { adminRoutes } from "./admin/routes"
import { type Auditor, audit, auditor, isAdmin } from "./audit"
import { type GitHubFetch, allowedOrigins, exchange, requireMutation, startLogin } from "./auth"
import { calendarRoutes } from "./calendar/routes"
import { computeHostRoute, computeRoutes, computeSocketRoute } from "./compute/routes"
import { agentRoutes } from "./devices/agent"
import { deviceRoutes } from "./devices/routes"
import { type Upstream, serveDocument } from "./docs"
import type { DocsManifest, Env } from "./env"
import type { AnthropicFetch } from "./gpt/chat"
import { gptRoutes } from "./gpt/routes"
import type { SkillsManifest } from "./gpt/skills"
import { HttpError, json, preflight, problem, redirect, withCors, withPrivateHeaders } from "./http"
import { type Session, readSession } from "./session"

// The Worker is an API. Browsers only ever show https://hafezigroupjqi.github.io: its service
// worker fetches the member edition of every page from GET /api/site/<path> with a bearer token,
// and forwards same-origin /api/* calls here. Lab PCs call /api/agent/* with device keys; the
// compute host holds /api/compute/host with its host key (src/compute/).

export const VERSION = "1.0.0"

// The member tool pages of the site (device-scoped instrument control, the calendar, Scratchpad).
export const MEMBER_PAGES = [
  "/calendar",
  "/devices",
  "/device",
  "/instrument",
  "/experiment-builder",
  "/experiments",
  "/gpt",
  "/admin",
  "/scratchpad",
]

const SITE_PREFIX = "/api/site"

// Assets that may sit in the browser cache for an hour. Scripts and styles only when their name
// carries a content hash (Quartz's `-1a2b3c4d.css`, esbuild's `static/chunks/`): an entry like
// /static/member-tools.js keeps its name across deploys, so caching it would run the previous
// deploy's code (and ask for chunks that no longer exist) for up to an hour.
const isHashedAsset = (pathname: string) => {
  if (pathname.startsWith("/resources/")) return false
  if (/\.(?:css|js)$/i.test(pathname))
    return /-[0-9a-f]{8}\.(?:css|js)$/.test(pathname) || pathname.startsWith("/static/chunks/")
  return /\.(?:woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico)$/i.test(pathname)
}

export interface HandlerOptions {
  /** Outbound fetch for the GitHub blob API; tests substitute a stub. */
  upstream?: Upstream
  /** Outbound fetch for GitHub OAuth + REST during sign-in; tests substitute a stub. */
  github?: GitHubFetch
  /** Outbound fetch for the Claude API (Hafezi GPT); tests substitute a scripted stub. */
  anthropic?: AnthropicFetch
  /** Repo skills baked in at build time (tools/gpt-manifest.mjs → generated/gpt-skills.json). */
  skills?: SkillsManifest
}

export function createHandler(
  manifest: DocsManifest,
  options: HandlerOptions = {},
): ExportedHandler<Env> {
  const documents = manifest.documents
  const upstream: Upstream = options.upstream ?? ((input, init) => fetch(input, init))
  const githubFetch: GitHubFetch = options.github ?? ((input, init) => fetch(input, init))
  const gptDeps = {
    manifest,
    skills: options.skills ?? { skills: [] },
    upstream,
    anthropicFetch: options.anthropic,
  }
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url)
      const origin = request.headers.get("origin")
      const allowed = allowedOrigins(env)
      // Machine callers (lab PCs, the compute host) never get CORS; they are not browsers.
      const isAgent = url.pathname.startsWith("/api/agent/") || url.pathname === "/api/compute/host"
      if (request.method === "OPTIONS" && !isAgent) return preflight(origin, allowed)
      let response: Response
      try {
        response = await route(request, url, env, ctx)
      } catch (error) {
        if (error instanceof HttpError)
          response = withPrivateHeaders(problem(error.status, error.detail))
        else {
          console.error(error)
          response = withPrivateHeaders(problem(500, "internal error"))
        }
      }
      // WebSocket upgrades (agents, compute host, JupyterLab) go back untouched.
      if (response.webSocket) return response
      return isAgent ? response : withCors(response, origin, allowed)
    },
  }

  async function route(
    request: Request,
    url: URL,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const path = url.pathname
    if (path === "/api/health") return json({ ok: true, version: VERSION })

    // Anything that is not the API belongs to the github.io site (old links, bookmarks).
    if (!path.startsWith("/api/"))
      return redirect(new URL(path + url.search, env.PUBLIC_SITE_URL).toString(), 302)

    // Agent ingest is device-key authenticated, before the member bearer is ever parsed.
    const agent = await agentRoutes(request, url, env)
    if (agent) return withPrivateHeaders(agent)
    // Likewise the compute host (host key) and JupyterLab's WebSockets (short ticket in ?token=,
    // because a browser WebSocket cannot carry the bearer header).
    const computeHost = await computeHostRoute(request, url, env)
    if (computeHost) return computeHost
    const computeSocket = await computeSocketRoute(request, url, env)
    if (computeSocket) return computeSocket

    if (path === "/api/auth/start" && request.method === "POST")
      return withPrivateHeaders(await startLogin(request, env))
    if (path === "/api/auth/exchange" && request.method === "POST")
      return withPrivateHeaders(await exchange(request, env, githubFetch, ctx))

    const session = await readSession(request, env)
    if (!session) {
      if (path === "/api/session") return withPrivateHeaders(json({ user: null }))
      return withPrivateHeaders(problem(401, "login required"))
    }
    const record = auditor(env, ctx, request, session)
    if (path === "/api/session")
      return withPrivateHeaders(
        json({
          user: {
            login: session.login,
            name: session.name,
            role: session.role,
            is_admin: await isAdmin(env, session),
          },
        }),
      )
    if (path === "/api/auth/logout" && request.method === "POST") {
      requireMutation(request, env)
      record("auth.logout")
      return withPrivateHeaders(json({ ok: true }))
    }
    if (path === SITE_PREFIX || path.startsWith(SITE_PREFIX + "/"))
      return site(request, url, env, ctx, path.slice(SITE_PREFIX.length) || "/", record)

    // The Scratchpad's compute relay audits its own control actions (compute.*): every JupyterLab
    // request is a POST envelope, which must not become an api.POST row each, and relayed answers
    // keep Jupyter's caching headers instead of the private no-store ones.
    const compute = await computeRoutes(request, url, env, session, record)
    if (compute) return compute

    // Every write is audited: routes record a specific event (device.create, gpt.share …); any
    // write that did not gets a generic api.<METHOD> row with its path and final status.
    const isWrite = request.method !== "GET" && request.method !== "HEAD"
    let status = 500
    try {
      const response = await memberRoutes(request, url, env, ctx, session, record)
      status = response.status
      return withPrivateHeaders(response)
    } catch (error) {
      if (error instanceof HttpError) status = error.status
      throw error
    } finally {
      if (isWrite && !record.recorded)
        audit(env, ctx, request, {
          login: session.login,
          role: session.role,
          action: `api.${request.method}`,
          target: path,
          status,
        })
    }
  }

  async function memberRoutes(
    request: Request,
    url: URL,
    env: Env,
    ctx: ExecutionContext,
    session: Session,
    record: Auditor,
  ): Promise<Response> {
    const admin = await adminRoutes(request, url, env, session, record)
    if (admin) return admin
    const gpt = await gptRoutes(request, url, env, ctx, session, record, gptDeps)
    if (gpt) return gpt
    const calendar = await calendarRoutes(request, url, env, session)
    if (calendar) return calendar
    const devices = await deviceRoutes(request, url, env, session, record)
    if (devices) return devices
    return problem(404, "not found")
  }

  // The member edition of the site: prerendered pages and assets from the ASSETS build, and
  // private documents streamed from vault-private. `sitePath` is the github.io path.
  async function site(
    request: Request,
    url: URL,
    env: Env,
    ctx: ExecutionContext,
    sitePath: string,
    record: Auditor,
  ): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD")
      throw new HttpError(405, "method not allowed")
    if (sitePath.startsWith("/__docs/")) throw new HttpError(404, "not found")
    if (sitePath === "/vault" || sitePath === "/vault/") return canonical("/resources/")
    const assetUrl = new URL(sitePath + url.search, url.origin)
    const range = request.headers.get("range")
    const asset = await env.ASSETS.fetch(
      new Request(assetUrl, {
        method: request.method,
        headers: range ? { range } : {},
        redirect: "manual",
      }),
    )
    // Trailing-slash / .html redirects: tell the service worker the canonical github.io path.
    if (asset.status >= 300 && asset.status < 400) {
      const location = asset.headers.get("location")
      if (location) {
        const target = new URL(location, assetUrl)
        return canonical(target.pathname + target.search)
      }
    }
    if (asset.status !== 404) return withPrivateHeaders(asset, { store: isHashedAsset(sitePath) })
    const docPath = decodeURIComponent(sitePath).replace(/^\//, "")
    const entry = documents[docPath]
    if (entry) {
      // One row per opened document, not per byte-range a PDF viewer asks for.
      if (request.method === "GET" && (!range || /^bytes=0-/.test(range)))
        record("doc.view", docPath)
      return serveDocument(request, docPath, entry, env, ctx, upstream)
    }
    return withPrivateHeaders(asset)
  }
}

const canonical = (path: string) =>
  withPrivateHeaders(new Response(null, { status: 204, headers: { "x-canonical-path": path } }))
