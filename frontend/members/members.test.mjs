import assert from "node:assert/strict"
import test from "node:test"
import { isLive, safeNext } from "./auth.js"
import { createSseParser } from "./sse-parse.js"
import {
  COMPUTE_KEEP_HEADERS,
  alwaysPass,
  isComputeStatic,
  isImmutable,
  isSessionExpired,
  route,
  target,
} from "./sw-route.js"

test("signed out, the service worker never touches a request", () => {
  for (const path of ["/", "/resources/notes", "/api/session", "/devices"])
    assert.equal(route({ method: "GET", path, mode: "navigate" }, false), "network")
})

test("signed in, pages and assets come from the member edition and /api goes to the Worker", () => {
  assert.equal(route({ method: "GET", path: "/resources/notes", mode: "navigate" }, true), "site")
  assert.equal(route({ method: "GET", path: "/", mode: "navigate" }, true), "site")
  assert.equal(
    route({ method: "GET", path: "/static/contentIndex.json", mode: "cors" }, true),
    "site",
  )
  assert.equal(route({ method: "GET", path: "/index-4bf5a71f.css", mode: "no-cors" }, true), "site")
  assert.equal(route({ method: "POST", path: "/api/devices", mode: "cors" }, true), "api")
  assert.equal(route({ method: "GET", path: "/api/session", mode: "cors" }, true), "api")
})

test("sign-in pages, the worker script and non-GET page requests are left alone", () => {
  for (const path of [
    "/auth/login",
    "/auth/callback",
    "/auth/logout",
    "/sw.js",
    "/static/members-auth.js",
  ]) {
    assert.equal(alwaysPass(path), true)
    assert.equal(route({ method: "GET", path, mode: "navigate" }, true), "network")
  }
  assert.equal(
    route({ method: "POST", path: "/resources/notes", mode: "navigate" }, true),
    "network",
  )
})

test("targets and cacheability", () => {
  assert.equal(
    target("site", "https://w.dev", "/resources/", "?x=1"),
    "https://w.dev/api/site/resources/?x=1",
  )
  assert.equal(target("api", "https://w.dev", "/api/devices", ""), "https://w.dev/api/devices")
  assert.equal(isImmutable("/postscript-a66fbddf.js"), true)
  assert.equal(isImmutable("/static/contentIndex.json"), false)
  assert.equal(isImmutable("/static/member-tools.js"), false)
})

test("every method under /jupyter/ goes through the compute envelope", () => {
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
    assert.equal(
      route({ method, path: "/jupyter/user/alice/api/contents/a.ipynb", mode: "cors" }, true),
      "compute",
    )
  assert.equal(
    route({ method: "GET", path: "/jupyter/user/alice/lab", mode: "navigate" }, true),
    "compute",
  )
  assert.equal(
    route({ method: "GET", path: "/jupyter/user/alice/lab", mode: "navigate" }, false),
    "network",
  )
  assert.equal(route({ method: "GET", path: "/jupyterish", mode: "navigate" }, true), "site")
  assert.equal(
    target("compute", "https://w.dev", "/jupyter/user/alice/lab", "?x=1"),
    "https://w.dev/api/compute/fetch",
  )
})

test("the lab iframe cannot reach the members API, except Hafezi GPT", () => {
  const fromLab = (path) =>
    route({ method: "POST", path, mode: "cors", clientPath: "/jupyter/user/alice/lab" }, true)
  assert.equal(fromLab("/api/devices"), "deny")
  assert.equal(fromLab("/api/session"), "deny")
  assert.equal(fromLab("/api/compute/server"), "deny")
  assert.equal(fromLab("/api/gpt/chat"), "api")
  assert.equal(fromLab("/jupyter/user/alice/api/kernels"), "compute")
  assert.equal(
    route(
      { method: "POST", path: "/api/compute/server", mode: "cors", clientPath: "/scratchpad" },
      true,
    ),
    "api",
  )
})

test("versioned Jupyter static files are cacheable; the API and pages are not", () => {
  assert.equal(isComputeStatic("/jupyter/user/alice/static/lab/main.js", "?v=8ae43c2f11d0"), true)
  assert.equal(
    isComputeStatic(
      "/jupyter/user/alice/lab/extensions/@jupyterlab/x/static/remoteEntry.5cbb9d2323598fbda535.js",
    ),
    true,
  )
  assert.equal(isComputeStatic("/jupyter/user/alice/static/lab/main.js"), false)
  assert.equal(
    isComputeStatic("/jupyter/user/alice/api/contents/static/a.js", "?v=8ae43c2f11d0"),
    false,
  )
  assert.equal(isComputeStatic("/jupyter/user/alice/lab", "?v=8ae43c2f11d0"), false)
})

test("only the Worker's own 401 signs a member out; compute responses keep the framing policy", () => {
  const response = (status, headers = {}) => new Response(null, { status, headers })
  assert.equal(isSessionExpired(response(401)), true)
  assert.equal(isSessionExpired(response(401, { "x-compute-upstream-status": "401" })), false)
  assert.equal(isSessionExpired(response(403, { "x-compute-upstream-status": "401" })), false)
  for (const name of ["content-security-policy", "x-frame-options", "etag", "content-type"])
    assert.ok(COMPUTE_KEEP_HEADERS.includes(name), name)
})

test("sessions expire a minute early; next targets stay on this site", () => {
  const now = 1_000_000_000_000
  assert.equal(isLive({ token: "t", exp: now / 1000 + 3600 }, now), true)
  assert.equal(isLive({ token: "t", exp: now / 1000 + 30 }, now), false)
  assert.equal(isLive(null, now), false)
  assert.equal(safeNext("/resources/?q=1"), "/resources/?q=1")
  for (const bad of ["https://evil.example", "//evil.example", "/x:y", "/auth/login", "", null])
    assert.equal(safeNext(bad), "/")
})

test("the SSE parser handles split chunks, CRLF, comments and multi-line data", () => {
  const events = []
  const parser = createSseParser((name, data) => events.push([name, data]))
  parser.feed("event: hel")
  parser.feed('lo\r\ndata: {"a":1}\r\n\r\n: keepalive\n\n')
  parser.feed("data: line1\ndata: line2\n\nevent: logs\ndata:[]\n\n")
  assert.deepEqual(events, [
    ["hello", '{"a":1}'],
    ["message", "line1\nline2"],
    ["logs", "[]"],
  ])
})
