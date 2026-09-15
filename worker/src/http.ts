export class HttpError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(detail)
  }
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })

export const problem = (status: number, detail: string) => json({ detail }, status)

export const redirect = (location: string, status = 302, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers: { location, ...headers } })

export function cookies(request: Request): Map<string, string> {
  const jar = new Map<string, string>()
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=")
    if (index < 0) continue
    jar.set(part.slice(0, index).trim(), part.slice(index + 1).trim())
  }
  return jar
}

export const isHtmlRequest = (request: Request, url: URL) => {
  if (request.method !== "GET" && request.method !== "HEAD") return false
  const last = url.pathname.split("/").pop() ?? ""
  if (!last.includes(".") || last.endsWith(".html")) return true
  return (request.headers.get("accept") ?? "").includes("text/html")
}

// Everything the member site serves is private. Pages and API answers are never stored;
// hashed static assets and documents may sit in the browser cache for an hour.
export function withPrivateHeaders(response: Response, { store = false } = {}): Response {
  const out = new Response(response.body, response)
  out.headers.set("vary", "Cookie")
  out.headers.set("cache-control", store ? "private, max-age=3600" : "private, no-store")
  out.headers.set("x-content-type-options", "nosniff")
  out.headers.set("x-robots-tag", "noindex, nofollow, noarchive")
  out.headers.set("referrer-policy", "no-referrer")
  return out
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new HttpError(422, "request body must be JSON")
  }
}
