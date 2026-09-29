// The members service worker for https://hafezigroupjqi.github.io (scope /). See sw-route.js for
// the routing rule. The browser never navigates to the Worker: responses are fetched here with
// the bearer token and handed back as ordinary github.io responses.

import { API_ORIGIN, clearAuth, readAuth } from "./auth.js"
import {
  KEEP_HEADERS,
  alwaysPass,
  isImmutable,
  isSessionExpired,
  notebookPage,
  route,
  target,
} from "./sw-route.js"

const ASSET_CACHE = "hafezi-assets-v1"
// Every other cache (such as the old hafezi-compute-v1 of lab files) is deleted on activation.
const CACHES = new Set([ASSET_CACHE])

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (!CACHES.has(name)) await caches.delete(name)
      await self.clients.claim()
    })(),
  ),
)

let cached = null
let loadedAt = 0
async function session() {
  if (!loadedAt || Date.now() - loadedAt > 30_000) {
    cached = await readAuth()
    loadedAt = Date.now()
  }
  return cached && cached.exp * 1000 > Date.now() ? cached : null
}

async function signedOut() {
  cached = null
  loadedAt = Date.now()
  await clearAuth()
  await caches.delete(ASSET_CACHE)
  for (const client of await self.clients.matchAll()) client.postMessage("signed-out")
}

self.addEventListener("message", (event) => {
  if (event.data === "signed-in") loadedAt = 0
  if (event.data === "signed-out") event.waitUntil(signedOut())
})

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || alwaysPass(url.pathname)) return
  event.respondWith(handle(event.request, url))
})

// Re-issue a Worker response as a plain same-origin response (the document keeps its github.io URL).
function reissue(response, keep = KEEP_HEADERS) {
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

async function handle(request, url) {
  const auth = await session()
  const kind = route(
    { method: request.method, path: url.pathname, mode: request.mode, search: url.search },
    !!auth,
  )
  if (kind === "network") return fetch(request)
  if (kind === "notebook")
    return Response.redirect(new URL(notebookPage(url.pathname), url.origin), 302)
  // The lab moved to its own origin: an old /jupyter/ link opens the Scratchpad instead.
  if (kind === "retired")
    return request.mode === "navigate"
      ? Response.redirect(new URL("/scratchpad", url.origin), 302)
      : Response.json({ detail: "open the lab from the Scratchpad" }, { status: 410 })

  const immutable = kind === "site" && request.method === "GET" && isImmutable(url.pathname)
  if (immutable) {
    const hit = await caches.match(url.pathname, { cacheName: ASSET_CACHE })
    if (hit) return hit
  }

  const headers = new Headers({ authorization: `Bearer ${auth.token}` })
  // Only what the Worker needs: a long navigation Accept header would force an extra CORS preflight.
  for (const name of ["content-type", "range"]) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  const init = { method: request.method, headers, redirect: "manual" }
  if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.arrayBuffer()

  let response
  try {
    response = await fetch(target(kind, API_ORIGIN, url.pathname, url.search), init)
  } catch {
    // The Worker is unreachable: show the public page rather than nothing.
    return kind === "api"
      ? Response.json({ detail: "members API unreachable" }, { status: 503 })
      : fetch(request)
  }
  if (isSessionExpired(response)) {
    await signedOut()
    return kind === "api" ? reissue(response) : fetch(request)
  }
  const canonical = response.headers.get("x-canonical-path")
  if (kind === "site" && canonical) return Response.redirect(new URL(canonical, url.origin), 301)
  const out = reissue(response)
  if (immutable && response.ok) {
    const cache = await caches.open(ASSET_CACHE)
    await cache.put(url.pathname, out.clone())
  }
  return out
}
