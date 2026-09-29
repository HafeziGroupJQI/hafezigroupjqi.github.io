import type { DocumentEntry, Env } from "./env"
import { SANDBOX_CSP, problem, withPrivateHeaders } from "./http"

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
  // ?raw (a notebook page's download link) saves the file instead of showing it.
  const disposition = new URL(request.url).searchParams.has("raw") ? "attachment" : "inline"
  // The type comes from this path's entry, not the cached blob's headers: two paths can share a
  // blob (an .html and a .txt copy), and the cache keeps whichever was asked for first.
  const finish = (response: Response) => {
    const out = withPrivateHeaders(response, { store: true })
    out.headers.set("content-type", entry.contentType)
    out.headers.set("content-disposition", `${disposition}; filename="${filename}"`)
    if (!isPassiveType(entry.contentType)) out.headers.set("content-security-policy", SANDBOX_CSP)
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

/**
 * Whether a document's type shows without running anything: PDFs, raster images, audio, video and
 * plain text. Everything else (HTML, SVG, XML, and any type this doesn't know) gets the sandbox
 * policy, so a file in vault-private never runs as the site, where the members token is. An SVG
 * used as an <img> still renders under it; PDFs go without it, as Hafezi GPT's uploads do, since
 * browsers refuse to show a PDF in a sandboxed document.
 */
export function isPassiveType(contentType: string): boolean {
  const type = contentType.split(";")[0].trim().toLowerCase()
  if (type.endsWith("/xml") || type.endsWith("+xml")) return false
  return (
    type === "application/pdf" || type === "text/plain" || /^(?:image|audio|video)\//.test(type)
  )
}
