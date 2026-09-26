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

// Everything the member API serves is private. Pages and API answers are never stored;
// hashed static assets and documents may sit in the browser cache for an hour.
export function withPrivateHeaders(response: Response, { store = false } = {}): Response {
  const out = new Response(response.body, response)
  out.headers.set("vary", "Origin, Authorization")
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

const CORS_ALLOW_HEADERS = "authorization, content-type, range, accept"
const CORS_EXPOSE_HEADERS = "content-disposition, content-range, accept-ranges, x-canonical-path"
const CORS_METHODS = "GET, HEAD, POST, PUT, DELETE, OPTIONS"

/** Add CORS headers when the request comes from an allowed browser origin (no credentials). */
export function withCors(response: Response, origin: string | null, allowed: Set<string>): Response {
  if (!origin || !allowed.has(origin)) return response
  const out = new Response(response.body, response)
  out.headers.set("access-control-allow-origin", origin)
  out.headers.set("access-control-expose-headers", CORS_EXPOSE_HEADERS)
  const vary = out.headers.get("vary")
  if (!vary?.toLowerCase().includes("origin")) out.headers.set("vary", vary ? `${vary}, Origin` : "Origin")
  return out
}

export function preflight(origin: string | null, allowed: Set<string>): Response {
  if (!origin || !allowed.has(origin)) return new Response(null, { status: 403 })
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": CORS_METHODS,
      "access-control-allow-headers": CORS_ALLOW_HEADERS,
      "access-control-max-age": "7200",
      vary: "Origin",
    },
  })
}
