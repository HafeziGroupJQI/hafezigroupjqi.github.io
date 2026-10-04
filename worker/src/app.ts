import { contentIndexFor } from "./acl/content-index"
import { aclRefs, aclViewer, canSee, deny, scrubLinks } from "./acl/index"
import { adminRoutes } from "./admin/routes"
import { announcementRoutes } from "./announcements"
import { type Auditor, audit, auditor, isAdmin } from "./audit"
import { type GitHubFetch, allowedOrigins, exchange, requireMutation, startLogin } from "./auth"
import { calendarRoutes } from "./calendar/routes"
import { changeRoutes } from "./changes"
import {
  computeHostRoute,
  computeRoutes,
  isLabPath,
  labRoute,
  signOutOfLabs,
} from "./compute/routes"
import { agentRoutes } from "./devices/agent"
import { deviceRoutes } from "./devices/routes"
import { type Upstream, documentPath, serveDocument } from "./docs"
import { editRoutes } from "./edit/routes"
import { historyRoutes } from "./history"
import type { DocsManifest, Env } from "./env"
import type { AnthropicFetch } from "./gpt/chat"
import { isLabGptPath, labGptRequest } from "./gpt/lab"
import { isLabAgentPath, labAgent } from "./gpt/lab-agent"
import { gptRoutes } from "./gpt/routes"
import { prefsRoutes } from "./prefs"
import { leaderboardRoutes } from "./ratings/leaderboard"
import { ratingRoutes } from "./ratings/routes"
import { recordView, viewedPage } from "./ratings/views"
import { navIdentity, profileRoutes } from "./profile/routes"
import type { VaultFetch } from "./profile/vault"
import type { RepoFetch } from "./repo"
import type { SkillsManifest } from "./gpt/skills"
import {
  HttpError,
  decodeSegment,
  json,
  preflight,
  problem,
  redirect,
  withCors,
  withPrivateHeaders,
} from "./http"
import { type Session, endSessions, readSession } from "./session"
import { uploadRoutes } from "./uploads/routes"

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
  "/settings",
  "/uploads",
  "/recent",
  "/leaderboard",
  "/edit",
  "/announcements",
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
  /** Outbound fetch for the public vault's GitHub API (profile edits); tests substitute a fake. */
  vault?: VaultFetch
  /** Outbound fetch for vault-private's GitHub API (members' uploads); tests substitute a fake. */
  privateVault?: RepoFetch
}

export function createHandler(
  manifest: DocsManifest,
  options: HandlerOptions = {},
): ExportedHandler<Env> {
  const documents = manifest.documents
  const upstream: Upstream = options.upstream ?? ((input, init) => fetch(input, init))
  const githubFetch: GitHubFetch = options.github ?? ((input, init) => fetch(input, init))
  const vaultFetch: VaultFetch = options.vault ?? ((input, init) => fetch(input, init))
  const privateVaultFetch: RepoFetch = options.privateVault ?? ((input, init) => fetch(input, init))
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
      // Machine callers (lab PCs, the compute host) never get CORS; they are not browsers. Nor does
      // the lab origin (JupyterLab served from here), whose requests are all same-origin.
      const isAgent =
        url.pathname.startsWith("/api/agent/") ||
        url.pathname === "/api/compute/host" ||
        isLabPath(url.pathname)
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
      // WebSocket upgrades (agents, compute host, the lab) go back untouched.
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

    // The lab's coding agent: a Messages API endpoint on the lab origin, for the member's own lab.
    if (isLabAgentPath(path)) return labAgent(request, url, env, ctx, gptDeps.anthropicFetch)

    // The lab agent's site tools and saved chats, on the lab origin: the lab ticket is its credential there.
    if (isLabGptPath(path)) {
      const lab = await labGptRequest(request, url, env)
      const record = auditor(env, ctx, lab.request, lab.session)
      const response = await gptRoutes(lab.request, lab.url, env, ctx, lab.session, record, gptDeps)
      if (!response) throw new HttpError(404, "not found")
      if (request.method !== "GET" && request.method !== "HEAD" && !record.recorded)
        record(`api.${request.method}`, lab.url.pathname)
      return withPrivateHeaders(response)
    }

    // JupyterLab on its own origin: the ticket in the path is its only credential.
    const lab = await labRoute(request, url, env, ctx)
    if (lab) return lab

    // Anything that is not the API belongs to the github.io site (old links, bookmarks).
    // Always on that site's own origin: "//host/…" or "/\\host/…" would otherwise name another host.
    if (!path.startsWith("/api/"))
      return redirect(
        new URL(
          path.replace(/^[/\\]+/, "/") + url.search,
          new URL(env.PUBLIC_SITE_URL).origin,
        ).toString(),
        302,
      )

    // Agent ingest is device-key authenticated, before the member bearer is ever parsed.
    const agent = await agentRoutes(request, url, env)
    if (agent) return withPrivateHeaders(agent)
    // Likewise the compute host (host key).
    const computeHost = await computeHostRoute(request, url, env)
    if (computeHost) return computeHost

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
            // The name and photo the member chose in /settings, for the navbar.
            ...(await navIdentity(env, session)),
          },
        }),
      )
    if (path === "/api/auth/logout" && request.method === "POST") {
      requireMutation(request, env)
      // Every session the member began before now ends, on every device: the site's bearers
      // (readSession) and the lab's tickets, whose open sockets the relay closes.
      await signOutOfLabs(env, session.login, await endSessions(env, session.login))
      record("auth.logout")
      return withPrivateHeaders(json({ ok: true }))
    }
    if (path === SITE_PREFIX || path.startsWith(SITE_PREFIX + "/"))
      return site(request, url, env, ctx, path.slice(SITE_PREFIX.length) || "/", session, record)

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
    const admin = await adminRoutes(
      request,
      url,
      env,
      session,
      record,
      vaultFetch,
      privateVaultFetch,
    )
    if (admin) return admin
    const gpt = await gptRoutes(request, url, env, ctx, session, record, gptDeps)
    if (gpt) return gpt
    const calendar = await calendarRoutes(request, url, env, session)
    if (calendar) return calendar
    const devices = await deviceRoutes(request, url, env, session, record)
    if (devices) return devices
    const profile = await profileRoutes(request, url, env, session, record, vaultFetch)
    if (profile) return profile
    const uploads = await uploadRoutes(request, url, env, session, record, privateVaultFetch)
    if (uploads) return uploads
    const edit = await editRoutes(request, url, env, session, record, {
      vault: vaultFetch,
      "vault-private": privateVaultFetch,
    })
    if (edit) return edit
    const changes = await changeRoutes(request, url, env)
    if (changes) return changes
    const prefs = await prefsRoutes(request, url, env, session, record)
    if (prefs) return prefs
    const ratings = await ratingRoutes(request, url, env, session, record, MEMBER_PAGES)
    if (ratings) return ratings
    const leaderboard = await leaderboardRoutes(request, url, env, session)
    if (leaderboard) return leaderboard
    const announcements = await announcementRoutes(request, url, env, ctx, session, record)
    if (announcements) return announcements
    const history = await historyRoutes(request, url, env, ctx, upstream)
    if (history) return history
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
    session: Session,
    record: Auditor,
  ): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD")
      throw new HttpError(405, "method not allowed")
    if (sitePath.startsWith("/__docs/")) throw new HttpError(404, "not found")
    if (sitePath === "/vault" || sitePath === "/vault/") return canonical("/resources/")
    const assetUrl = new URL(sitePath + url.search, url.origin)
    const range = request.headers.get("range")
    // Restricted pages (src/acl/): a path showing anything a member may not read is the site's
    // own 404, as if it weren't there, before anything is fetched, a redirect included. The build's
    // maps behind these checks aren't anyone's to read but admins'.
    const viewer = await aclViewer(env, session)
    const decoded = decodeSegment(sitePath)
    const notFound = async () =>
      withPrivateHeaders(
        await env.ASSETS.fetch(
          new Request(new URL("/__restricted__/", url.origin), { method: request.method }),
        ),
      )
    if (!viewer.open) {
      if (ACL_FILES.test(decoded)) return notFound()
      if (!canSee(viewer, await aclRefs(env), decoded)) {
        deny(record, session.login, decoded)
        return notFound()
      }
    }
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
    // The content index as this member may read it: restricted pages' entries only for their people.
    if (decoded === "/static/contentIndex.json" && asset.ok)
      return withPrivateHeaders(await contentIndexFor(env, viewer, asset))
    if (asset.status !== 404) {
      // A page read: its readers on /leaderboard (src/ratings/views.ts), after the answer.
      const page = viewedPage(
        sitePath,
        request.method,
        asset,
        MEMBER_PAGES,
        request.headers.get("accept"),
      )
      if (page) recordView(env, ctx, session.login, page)
      // A page's links to restricted pages it may not read, and blocks of them (folder rows,
      // transclusions the build marked data-acl), from the rules as they are now.
      if (asset.ok && !viewer.open && /^text\/html/i.test(asset.headers.get("content-type") ?? ""))
        return withPrivateHeaders(
          scrubLinks(asset, viewer, await aclRefs(env), decoded, env.PUBLIC_SITE_URL),
        )
      return withPrivateHeaders(asset, { store: isHashedAsset(sitePath) })
    }
    const docPath = decoded.replace(/^\//, "")
    const entry = Object.hasOwn(documents, docPath) ? documents[docPath] : undefined
    if (entry && !viewer.canRead(documentPath(docPath, entry))) {
      deny(record, session.login, decoded)
      return notFound()
    }
    if (entry) {
      // One row per opened document, not per byte-range a PDF viewer asks for.
      if (request.method === "GET" && (!range || /^bytes=0-/.test(range)))
        record("doc.view", docPath)
      return serveDocument(request, docPath, entry, env, ctx, upstream)
    }
    return withPrivateHeaders(asset)
  }
}

/** The build's maps of restricted pages (static/acl-refs.json, the content index's offsets and
 *  per-rule shards, src/acl/): they name restricted pages, so members never get them whole. */
const ACL_FILES = /^\/static\/(?:acl-refs\.json|contentIndex\.offsets\.json|acl-index\/)/

const canonical = (path: string) =>
  withPrivateHeaders(new Response(null, { status: 204, headers: { "x-canonical-path": path } }))
