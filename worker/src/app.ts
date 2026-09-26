import { type GitHubFetch, allowedOrigins, exchange, startLogin } from "./auth"
import { calendarRoutes } from "./calendar/routes"
import { agentRoutes } from "./devices/agent"
import { deviceRoutes } from "./devices/routes"
import { type Upstream, serveDocument } from "./docs"
import type { DocsManifest, Env } from "./env"
import { HttpError, json, preflight, problem, redirect, withCors, withPrivateHeaders } from "./http"
import { readSession } from "./session"

// The Worker is an API. Browsers only ever show https://hafezigroupjqi.github.io: its service
// worker fetches the member edition of every page from GET /api/site/<path> with a bearer token,
// and forwards same-origin /api/* calls here. Lab PCs call /api/agent/* with device keys.

export const VERSION = "1.0.0"

// The member tool pages of the site (device-scoped instrument control + the calendar).
export const MEMBER_PAGES = [
  "/calendar",
  "/devices",
  "/device",
  "/instrument",
  "/experiment-builder",
  "/experiments",
]

const SITE_PREFIX = "/api/site"

const isHashedAsset = (pathname: string) =>
  /\.(?:css|js|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico)$/i.test(pathname) &&
  !pathname.startsWith("/resources/")

export interface HandlerOptions {
  /** Outbound fetch for the GitHub blob API; tests substitute a stub. */
  upstream?: Upstream
  /** Outbound fetch for GitHub OAuth + REST during sign-in; tests substitute a stub. */
  github?: GitHubFetch
}

export function createHandler(
  manifest: DocsManifest,
  options: HandlerOptions = {},
): ExportedHandler<Env> {
  const documents = manifest.documents
  const upstream: Upstream = options.upstream ?? ((input, init) => fetch(input, init))
  const githubFetch: GitHubFetch = options.github ?? ((input, init) => fetch(input, init))
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url)
      const origin = request.headers.get("origin")
      const allowed = allowedOrigins(env)
      // Machine callers (lab PCs) never get CORS; they are not browsers.
      const isAgent = url.pathname.startsWith("/api/agent/")
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

    if (path === "/api/auth/start" && request.method === "POST")
      return withPrivateHeaders(await startLogin(request, env))
    if (path === "/api/auth/exchange" && request.method === "POST")
      return withPrivateHeaders(await exchange(request, env, githubFetch))

    const session = await readSession(request, env)
    if (!session) {
      if (path === "/api/session") return withPrivateHeaders(json({ user: null }))
      return withPrivateHeaders(problem(401, "login required"))
    }
    if (path === "/api/session")
      return withPrivateHeaders(
        json({ user: { login: session.login, name: session.name, role: session.role } }),
      )
    if (path === SITE_PREFIX || path.startsWith(SITE_PREFIX + "/"))
      return site(request, url, env, ctx, path.slice(SITE_PREFIX.length) || "/")
    const calendar = await calendarRoutes(request, url, env, session)
    if (calendar) return withPrivateHeaders(calendar)
    const devices = await deviceRoutes(request, url, env, session)
    if (devices) return withPrivateHeaders(devices)
    return withPrivateHeaders(problem(404, "not found"))
  }

  // The member edition of the site: prerendered pages and assets from the ASSETS build, and
  // private documents streamed from vault-private. `sitePath` is the github.io path.
  async function site(
    request: Request,
    url: URL,
    env: Env,
    ctx: ExecutionContext,
    sitePath: string,
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
    if (entry) return serveDocument(request, docPath, entry, env, ctx, upstream)
    return withPrivateHeaders(asset)
  }
}

const canonical = (path: string) =>
  withPrivateHeaders(new Response(null, { status: 204, headers: { "x-canonical-path": path } }))
