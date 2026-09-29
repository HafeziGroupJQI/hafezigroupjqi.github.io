import assert from "node:assert/strict"
import test from "node:test"
import { isLive, safeNext } from "./auth.js"
import { createSseParser } from "./sse-parse.js"
import {
  alwaysPass,
  isImmutable,
  isSessionExpired,
  notebookPage,
  reissue,
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

test("opening a raw notebook shows its rendered page; its download link still gets the file", () => {
  const go = (path, search = "", mode = "navigate") =>
    route({ method: "GET", path, mode, search }, true)
  assert.equal(go("/resources/code/jumpstart/01_ring.ipynb"), "notebook")
  assert.equal(go("/resources/code/wolfram-guide/eiwl3-01.NB"), "notebook")
  assert.equal(
    notebookPage("/resources/code/bend-optimization.qmd"),
    "/resources/code/bend-optimization",
  )
  assert.equal(
    notebookPage("/resources/code/jumpstart/01_ring.ipynb"),
    "/resources/code/jumpstart/01_ring",
  )
  assert.equal(go("/resources/code/jumpstart/01_ring.ipynb", "?raw=1"), "site")
  assert.equal(go("/resources/code/jumpstart/01_ring.ipynb", "", "cors"), "site")
  assert.equal(go("/resources/code/jumpstart/01_ring"), "site")
  assert.equal(route({ method: "GET", path: "/x.ipynb", mode: "navigate" }, false), "network")
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

test("a re-issued response keeps the Worker's sandbox policy and nosniff, not its other headers", async () => {
  const worker = new Response("<svg onload=alert(1)>", {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": "sandbox; default-src 'none'",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "https://hafezigroupjqi.github.io",
      "set-cookie": "a=b",
    },
  })
  const out = reissue(worker)
  assert.equal(out.headers.get("content-type"), "text/plain; charset=utf-8")
  assert.equal(out.headers.get("content-security-policy"), "sandbox; default-src 'none'")
  assert.equal(out.headers.get("x-content-type-options"), "nosniff")
  assert.equal(out.headers.get("access-control-allow-origin"), null)
  assert.equal(await out.text(), "<svg onload=alert(1)>")
  assert.equal(reissue(new Response(null, { status: 204 })).status, 204)
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

test("the lab is not served here any more: old /jupyter/ links are retired", () => {
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
    assert.equal(
      route({ method, path: "/jupyter/user/alice/api/contents/a.ipynb", mode: "cors" }, true),
      "retired",
    )
  assert.equal(
    route({ method: "GET", path: "/jupyter/user/alice/lab", mode: "navigate" }, true),
    "retired",
  )
  assert.equal(
    route({ method: "GET", path: "/jupyter/user/alice/lab", mode: "navigate" }, false),
    "network",
  )
  assert.equal(route({ method: "GET", path: "/jupyterish", mode: "navigate" }, true), "site")
  assert.equal(route({ method: "POST", path: "/api/gpt/chat", mode: "cors" }, true), "api")
})

test("a 401 from the Worker signs a member out", () => {
  const response = (status) => new Response(null, { status })
  assert.equal(isSessionExpired(response(401)), true)
  assert.equal(isSessionExpired(response(403)), false)
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
