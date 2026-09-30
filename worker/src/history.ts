import type { Upstream } from "./docs"
import type { Env } from "./env"
import { HttpError, SANDBOX_CSP, withPrivateHeaders } from "./http"
import { vaultPath } from "./uploads/rules"

// A private page's file as it was at a commit, for the page's History (frontend/page-history/):
// GET /api/history/file?repo=vault-private&rev=<commit>&path=<file>, members only, pages only
// (Markdown, Quarto, notebooks), from vault-private on GitHub with the documents token. The public
// vault's revisions come straight from raw.githubusercontent.com, since that vault is public. A
// file at a commit never changes, so the first answer stays in the edge cache for good.

const USER_AGENT = "hafezi-members-worker"
const PAGE = /\.(?:md|qmd|ipynb)$/i
const COMMIT = /^[0-9a-f]{40}$/

/** A page of vault-private, as its history may name it; a 422 for anything else. */
export function historyPath(raw: unknown): string {
  let path: string
  try {
    path = vaultPath(raw)
  } catch {
    path = ""
  }
  if (!PAGE.test(path)) throw new HttpError(422, "path must be a page of the private vault")
  return path
}

export async function historyRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  upstream: Upstream,
): Promise<Response | null> {
  if (url.pathname !== "/api/history/file") return null
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method not allowed")
  if (url.searchParams.get("repo") !== "vault-private")
    throw new HttpError(422, "only the private vault's revisions come from here")
  const rev = url.searchParams.get("rev") ?? ""
  if (!COMMIT.test(rev)) throw new HttpError(422, "rev must be a commit's full sha")
  const path = historyPath(url.searchParams.get("path"))
  // Private and never stored by the browser, as every member answer is (src/app.ts): the edge
  // cache is what spares GitHub.
  const finish = (response: Response) => {
    const out = withPrivateHeaders(response)
    out.headers.set("content-security-policy", SANDBOX_CSP)
    return out
  }
  const key = new Request(new URL(`/__history/${rev}/${encodeURIComponent(path)}`, url).toString())
  const cached = await caches.default.match(key)
  if (cached) return finish(cached)
  if (!env.GITHUB_DOCS_TOKEN) throw new HttpError(503, "the document store is not configured")
  const file = await upstream(
    `https://api.github.com/repos/${env.DOCS_REPO}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}?ref=${rev}`,
    {
      headers: {
        accept: "application/vnd.github.raw+json",
        authorization: `Bearer ${env.GITHUB_DOCS_TOKEN}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": USER_AGENT,
      },
    },
  )
  if (file.status === 404) throw new HttpError(404, "that page isn't in that revision")
  if (!file.ok || !file.body) throw new HttpError(502, "GitHub did not answer; try again shortly")
  // Text, whatever the page holds: the History dialog reads and diffs it, and nothing runs.
  const headers = {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "public, max-age=31536000, immutable",
  }
  if (request.method === "HEAD") {
    ctx.waitUntil(caches.default.put(key, new Response(file.body, { headers })))
    return finish(new Response(null, { headers }))
  }
  const [toCache, toClient] = file.body.tee()
  ctx.waitUntil(caches.default.put(key, new Response(toCache, { headers })))
  return finish(new Response(toClient, { headers }))
}
