// Pure routing for the service worker (sw.js). Signed out, the browser sees the public GitHub
// Pages build untouched. Signed in, every same-origin GET is answered with the member edition
// from the Worker (GET /api/site/<path>), and same-origin /api/* calls are forwarded with the
// bearer token. The sign-in pages and the service worker script itself are always left alone.
// The Scratchpad's JupyterLab lives under /jupyter/: every request there (any method) is wrapped in
// the compute envelope, POST /api/compute/fetch with x-compute-method / x-compute-target.

export const ALWAYS_PASS = [/^\/auth\//, /^\/sw\.js$/, /^\/static\/members-auth\.js$/]

/** Hashed build artifacts (index-4bf5a71f.css, postscript-…js) never change and can be cached. */
export const isImmutable = (path) => /-[0-9a-f]{8}\.(?:css|js)$/.test(path)

export const alwaysPass = (path) => ALWAYS_PASS.some((pattern) => pattern.test(path))

export const isCompute = (path) => path === "/jupyter" || path.startsWith("/jupyter/")

/**
 * Jupyter's own static files (versioned with ?v= or a content hash) can be cached per member.
 * @param {string} path
 * @param {string} [search]
 */
export const isComputeStatic = (path, search = "") =>
  /^\/jupyter\/user\/[a-z0-9-]+\/(?:static|lab\/extensions\/.+\/static)\//.test(path) &&
  (/[?&]v=[0-9a-f]{6,}/.test(search) || /[.-][0-9a-f]{16,}\.(?:js|css|woff2?)$/.test(path))

/**
 * @param {{method: string, path: string, mode?: string, clientPath?: string}} request
 *   same-origin request; clientPath is the URL path of the page that issued it, when known
 * @param {boolean} signedIn
 * @returns {"network" | "site" | "api" | "compute" | "deny"}
 */
export function route({ method, path, mode, clientPath }, signedIn) {
  if (!signedIn || alwaysPass(path)) return "network"
  if (isCompute(path)) return "compute"
  if (path === "/api" || path.startsWith("/api/")) {
    // Code running in the lab iframe is the member's own, but it must not drive the rest of the
    // members API with their session. Hafezi GPT is the one exception (the gpt-bridge extension).
    if (clientPath && isCompute(clientPath) && !path.startsWith("/api/gpt/")) return "deny"
    return "api"
  }
  // Never replay a form POST (or anything but a read) into the member site.
  if (method !== "GET" && method !== "HEAD") return "network"
  if (mode === "navigate") return "site"
  return "site"
}

/** Where a routed request goes on the Worker. */
export function target(kind, apiOrigin, path, search = "") {
  if (kind === "compute") return `${apiOrigin}/api/compute/fetch`
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

// JupyterLab responses also keep the framing policy the Worker forces and the upstream status.
export const COMPUTE_KEEP_HEADERS = [
  ...KEEP_HEADERS,
  "content-security-policy",
  "x-frame-options",
  "x-compute-upstream-status",
]

/** A 401 means the session is gone only when it is the Worker's own answer, not Jupyter's. */
export const isSessionExpired = (response) =>
  response.status === 401 && !response.headers.get("x-compute-upstream-status")
