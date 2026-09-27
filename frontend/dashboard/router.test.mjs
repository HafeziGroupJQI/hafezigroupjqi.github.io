import assert from "node:assert/strict"
import test from "node:test"
import { buildHref, legacyRedirect, parseRoute } from "./router.js"

test("defaults to the overview grid", () => {
  assert.deepEqual(parseRoute(""), {
    tab: "overview",
    code: null,
    id: null,
    layout: "grid",
    focus: null,
  })
})

test("invalid values fall back", () => {
  const r = parseRoute("?tab=nope&layout=cube&code=BAD CODE&id=../x")
  assert.equal(r.tab, "overview")
  assert.equal(r.layout, "grid")
  assert.equal(r.code, null)
  assert.equal(r.id, null)
})

test("wall implies overview; layouts only apply to the overview", () => {
  assert.equal(parseRoute("?tab=device&code=x&layout=wall").tab, "overview")
  assert.equal(parseRoute("?tab=device&code=x&layout=list").layout, "grid")
})

test("canonical hrefs round-trip", () => {
  for (const href of [
    "/devices",
    "/devices?layout=list",
    "/devices?layout=wall",
    "/devices?code=bench-1&layout=focus",
    "/devices?tab=device&code=bench-1",
    "/devices?tab=instruments&code=bench-1&id=sim-smu",
    "/devices?tab=experiments&code=bench-1&focus=Experiment_1_iv",
    "/devices?tab=experiments",
    "/devices?tab=activity&code=bench-1",
    "/devices?tab=builder&code=bench-1",
  ])
    assert.equal(buildHref(parseRoute(href.split("?")[1] ?? "")), href)
})

test("legacy pages map onto dashboard tabs", () => {
  assert.equal(legacyRedirect("/device", "?code=x"), "/devices?tab=device&code=x")
  assert.equal(
    legacyRedirect("/instrument", "?code=x&id=y"),
    "/devices?tab=instruments&code=x&id=y",
  )
  assert.equal(
    legacyRedirect("/experiments", "?code=x&focus=E"),
    "/devices?tab=experiments&code=x&focus=E",
  )
  assert.equal(legacyRedirect("/experiment-builder.html", "?code=x"), "/devices?tab=builder&code=x")
  assert.equal(legacyRedirect("/experiments", ""), "/devices?tab=experiments")
})
