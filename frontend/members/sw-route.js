// Pure routing for the service worker (sw.js). Signed out, the browser sees the public GitHub
// Pages build untouched. Signed in, every same-origin GET is answered with the member edition
// from the Worker (GET /api/site/<path>), and same-origin /api/* calls are forwarded with the
// bearer token. The sign-in pages and the service worker script itself are always left alone.

export const ALWAYS_PASS = [/^\/auth\//, /^\/sw\.js$/, /^\/static\/members-auth\.js$/]

/** Hashed build artifacts (index-4bf5a71f.css, postscript-…js) never change and can be cached. */
export const isImmutable = (path) => /-[0-9a-f]{8}\.(?:css|js)$/.test(path)

export const alwaysPass = (path) => ALWAYS_PASS.some((pattern) => pattern.test(path))

/**
 * @param {{method: string, path: string, mode?: string}} request   same-origin request
 * @param {boolean} signedIn
 * @returns {"network" | "site" | "api"}
 */
export function route({ method, path, mode }, signedIn) {
  if (!signedIn || alwaysPass(path)) return "network"
  if (path === "/api" || path.startsWith("/api/")) return "api"
  // Never replay a form POST (or anything but a read) into the member site.
  if (method !== "GET" && method !== "HEAD") return "network"
  if (mode === "navigate") return "site"
  return "site"
}

/** Where a routed request goes on the Worker. */
export function target(kind, apiOrigin, path, search = "") {
  return kind === "api" ? `${apiOrigin}${path}${search}` : `${apiOrigin}/api/site${path}${search}`
}

// Headers a proxied response keeps when it is re-issued as a github.io response.
export const KEEP_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
  "content-range",
  "accept-ranges",
  "cache-control",
  "last-modified",
  "etag",
]
