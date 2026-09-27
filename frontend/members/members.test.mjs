import assert from "node:assert/strict"
import test from "node:test"
import { isLive, safeNext } from "./auth.js"
import { createSseParser } from "./sse-parse.js"
import { alwaysPass, isImmutable, route, target } from "./sw-route.js"

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
