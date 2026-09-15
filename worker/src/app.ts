import { callback, login, loginUrl, logout } from "./auth"
import { calendarRoutes } from "./calendar/routes"
import { type Upstream, serveDocument } from "./docs"
import type { DocsManifest, Env } from "./env"
import { HttpError, isHtmlRequest, json, problem, redirect, withPrivateHeaders } from "./http"
import { readSession } from "./session"

export const VERSION = "1.0.0"

const isHashedAsset = (pathname: string) =>
  /\.(?:css|js|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico)$/i.test(pathname) &&
  !pathname.startsWith("/resources/")

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
    if (path === "/auth/logout") return withPrivateHeaders(logout(url, env))
    if (path.startsWith("/__docs/")) return withPrivateHeaders(problem(404, "not found"))

    const session = await readSession(request, env)
    if (!session) {
      if (path === "/api/session") return withPrivateHeaders(json({ user: null, csrf: null }))
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
