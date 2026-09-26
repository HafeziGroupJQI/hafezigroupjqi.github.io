import { callback, login, loginUrl, logout } from "./auth"
import { calendarRoutes } from "./calendar/routes"
import { agentRoutes } from "./devices/agent"
import { deviceRoutes } from "./devices/routes"
import { type Upstream, serveDocument } from "./docs"
import type { DocsManifest, Env } from "./env"
import { HttpError, isHtmlRequest, json, problem, redirect, withPrivateHeaders } from "./http"
import { readSession } from "./session"

export const VERSION = "1.0.0"

const isHashedAsset = (pathname: string) =>
  /\.(?:css|js|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico)$/i.test(pathname) &&
  !pathname.startsWith("/resources/")

// Member-only paths in the unified site: private vault-private pages and the member tool pages.
// Logged-out visitors are sent to login for these even when public browsing is on; everything
// else (the public group site) is served to everyone.
const isPrivatePath = (pathname: string) => {
  const p = decodeURIComponent(pathname)
    .replace(/\/index\.html$/, "/")
    .replace(/\.html$/, "")
  return (
    p === "/resources" ||
    p.startsWith("/resources/") ||
    p.startsWith("/assets/excalidraw/resources/") ||
    MEMBER_PAGES.some((t) => p === t || p.startsWith(t + "/"))
  )
}

// The member tool pages in the unified site (device-scoped instrument control + the calendar).
export const MEMBER_PAGES = [
  "/calendar",
  "/devices",
  "/device",
  "/instrument",
  "/experiment-builder",
  "/experiments",
]

// Same rule against a bare content-index slug (no leading slash, no extension).
const isPrivateSlug = (slug: string) =>
  slug === "resources" ||
  slug.startsWith("resources/") ||
  slug.startsWith("assets/excalidraw/resources/") ||
  MEMBER_PAGES.map((p) => p.slice(1)).some((t) => slug === t || slug.startsWith(t + "/"))

// The search/graph index lists every page. For logged-out visitors, strip private entries so the
// title and text of member pages are never delivered to the browser.
async function publicContentIndex(request: Request, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(request)
  if (!res.ok) return withPrivateHeaders(res)
  const all = (await res.json()) as Record<string, unknown>
  const filtered = Object.fromEntries(Object.entries(all).filter(([slug]) => !isPrivateSlug(slug)))
  return withPrivateHeaders(json(filtered), { store: true })
}

export interface HandlerOptions {
  /** Outbound fetch for the GitHub blob API; tests substitute a stub. */
  upstream?: Upstream
}

export function createHandler(
  manifest: DocsManifest,
  options: HandlerOptions = {},
): ExportedHandler<Env> {
  const documents = manifest.documents
  const upstream: Upstream = options.upstream ?? ((input, init) => fetch(input, init))
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url)
      try {
        return await route(request, url, env, ctx)
      } catch (error) {
        if (error instanceof HttpError)
          return withPrivateHeaders(problem(error.status, error.detail))
        console.error(error)
        return withPrivateHeaders(problem(500, "internal error"))
      }
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
    if (path === "/auth/login") return withPrivateHeaders(await login(request, url, env))
    if (path === "/auth/callback") return withPrivateHeaders(await callback(request, url, env))
    if (path === "/auth/logout") return withPrivateHeaders(logout(url))
    if (path.startsWith("/__docs/")) return withPrivateHeaders(problem(404, "not found"))

    // Agent ingest is device-key authenticated, before the cookie/session gate.
    const agent = await agentRoutes(request, url, env)
    if (agent) return withPrivateHeaders(agent)

    const session = await readSession(request, env)
    if (!session) {
      if (path === "/api/session") return withPrivateHeaders(json({ user: null, csrf: null }))
      // Public browsing: serve static pages/assets to logged-out visitors, so the group site
      // renders with the "Sign in with GitHub" link available. Private document streaming
      // (serveDocument) and every member API stay gated below — this only serves ASSETS.
      if (
        env.ALLOW_PUBLIC_BROWSING === "1" &&
        !path.startsWith("/api/") &&
        !isPrivatePath(path) &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        if (path === "/static/contentIndex.json") return publicContentIndex(request, env)
        if (path === "/vault" || path === "/vault/")
          return withPrivateHeaders(redirect("/resources/", 308))
        const asset = await env.ASSETS.fetch(request)
        return withPrivateHeaders(asset, { store: isHashedAsset(path) })
      }
      if (isHtmlRequest(request, url) && !path.startsWith("/api/"))
        return withPrivateHeaders(redirect(loginUrl(url)))
      return withPrivateHeaders(problem(401, "login required"))
    }
    if (path === "/api/session")
      return withPrivateHeaders(
        json({
          user: { login: session.login, name: session.name, role: session.role },
          csrf: session.csrf,
        }),
      )
    const calendar = await calendarRoutes(request, url, env, session)
    if (calendar) return withPrivateHeaders(calendar)
    const devices = await deviceRoutes(request, url, env, session)
    if (devices) return withPrivateHeaders(devices)
    if (path.startsWith("/api/")) return withPrivateHeaders(problem(404, "not found"))
    if (path === "/vault" || path === "/vault/")
      return withPrivateHeaders(redirect("/resources/", 308))
    if (request.method !== "GET" && request.method !== "HEAD")
      return withPrivateHeaders(problem(405, "method not allowed"))

    const asset = await env.ASSETS.fetch(request)
    if (asset.status !== 404) return withPrivateHeaders(asset, { store: isHashedAsset(path) })
    const sitePath = decodeURIComponent(path).replace(/^\//, "")
    const entry = documents[sitePath]
    if (entry) return serveDocument(request, sitePath, entry, env, ctx, upstream)
    return withPrivateHeaders(asset)
  }
}
