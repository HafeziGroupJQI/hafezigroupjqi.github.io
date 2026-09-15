import type { DocumentEntry, Env } from "./env"
import { problem, withPrivateHeaders } from "./http"

const USER_AGENT = "hafezi-members-worker"

// Private documents live only in vault-private on GitHub. The build lists each one with its
// git blob sha; the Worker fetches the blob on first use and keeps it in the edge cache
// under that sha, so a changed file gets a new key and nothing needs purging.
export type Upstream = (input: string, init: RequestInit) => Promise<Response>

export async function serveDocument(
  request: Request,
  sitePath: string,
  entry: DocumentEntry,
  env: Env,
  ctx: ExecutionContext,
  upstream: Upstream = (input, init) => fetch(input, init),
): Promise<Response> {
  const filename = (sitePath.split("/").pop() ?? "document").replace(/["\\]/g, "")
  const finish = (response: Response) => {
    const out = withPrivateHeaders(response, { store: true })
    out.headers.set("content-disposition", `inline; filename="${filename}"`)
    return out
  }
  const cache = caches.default
  const key = new URL(`/__docs/${entry.sha}`, request.url).toString()
  const range = request.headers.get("range")
  const cached = await cache.match(new Request(key, { headers: range ? { range } : {} }))
  if (cached) return finish(cached)
  if (!env.GITHUB_DOCS_TOKEN) return problem(503, "document store not configured")
  const blob = await upstream(
    `https://api.github.com/repos/${env.DOCS_REPO}/git/blobs/${entry.sha}`,
    {
      headers: {
        accept: "application/vnd.github.raw+json",
        authorization: `Bearer ${env.GITHUB_DOCS_TOKEN}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": USER_AGENT,
      },
    },
  )
  if (!blob.ok || !blob.body) return problem(502, "document store unavailable")
  const headers = {
    "content-type": entry.contentType,
    "content-length": String(entry.size),
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000, immutable",
  }
  const [toCache, toClient] = blob.body.tee()
  ctx.waitUntil(cache.put(new Request(key), new Response(toCache, { headers })))
  return finish(new Response(request.method === "HEAD" ? null : toClient, { status: 200, headers }))
}
