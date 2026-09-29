// Pure routing for the service worker (sw.js). Signed out, the browser sees the public GitHub
// Pages build untouched. Signed in, every same-origin GET is answered with the member edition
// from the Worker (GET /api/site/<path>), and same-origin /api/* calls are forwarded with the
// bearer token. The sign-in pages and the service worker script itself are always left alone.
// The Scratchpad's JupyterLab no longer lives here: it has its own origin (the Worker's), so code in
// a lab can never run beside the members token. Old /jupyter/ links are sent to the Scratchpad.

export const ALWAYS_PASS = [/^\/auth\//, /^\/sw\.js$/, /^\/static\/members-auth\.js$/]

/** Hashed build artifacts (index-4bf5a71f.css, postscript-…js) never change and can be cached. */
export const isImmutable = (path) => /-[0-9a-f]{8}\.(?:css|js)$/.test(path)

export const alwaysPass = (path) => ALWAYS_PASS.some((pattern) => pattern.test(path))

export const isCompute = (path) => path === "/jupyter" || path.startsWith("/jupyter/")

/** A raw notebook's or .qmd's path: its rendered page is the same path without the extension. */
export const notebookPage = (path) => path.replace(/\.(ipynb|nb|qmd)$/i, "")

/**
 * @param {{method: string, path: string, mode?: string, search?: string}} request  a same-origin request
 * @param {boolean} signedIn
 * @returns {"network" | "site" | "api" | "retired" | "notebook"}
 */
export function route({ method, path, mode, search = "" }, signedIn) {
  if (!signedIn || alwaysPass(path)) return "network"
  if (isCompute(path)) return "retired"
  if (path === "/api" || path.startsWith("/api/")) return "api"
  // Never replay a form POST (or anything but a read) into the member site.
  if (method !== "GET" && method !== "HEAD") return "network"
  // Opening a raw notebook in the browser shows its rendered page; ?raw (the page's own download
  // link) and anything but a navigation (a fetch, a download) still get the file.
  if (mode === "navigate" && notebookPage(path) !== path && !new URLSearchParams(search).has("raw"))
    return "notebook"
  return "site"
}

/** Where a routed request goes on the Worker. */
export function target(kind, apiOrigin, path, search = "") {
  return kind === "api" ? `${apiOrigin}${path}${search}` : `${apiOrigin}/api/site${path}${search}`
}

// Headers a proxied response keeps when it is re-issued as a github.io response. The Worker's
// sandbox policy and nosniff go along: a member's upload must not run as the site, where the
// members token is (the Worker exposes both to this cross-origin fetch).
export const KEEP_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
  "content-range",
  "accept-ranges",
  "cache-control",
  "last-modified",
  "etag",
  "content-security-policy",
  "x-content-type-options",
]

/** Re-issue a Worker response as a plain same-origin response (the document keeps its github.io URL). */
export function reissue(response, keep = KEEP_HEADERS) {
  const headers = new Headers()
  for (const name of keep) {
    const value = response.headers.get(name)
    if (value) headers.set(name, value)
  }
  const empty = response.status === 204 || response.status === 304
  return new Response(empty ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** A 401 from the Worker means the session is gone. */
export const isSessionExpired = (response) => response.status === 401
