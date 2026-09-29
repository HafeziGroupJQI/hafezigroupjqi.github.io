import test from "node:test"
import assert from "node:assert/strict"
import {
  nextTab,
  auditParams,
  budgetUsed,
  describe,
  formatTokens,
  parseBudget,
  tabUrl,
} from "./model.js"

test("a tab's URL keeps a conversations deep link only on that tab", () => {
  const deep = "https://site.example/admin?tab=conversations&member=ada&c=c_1"
  assert.equal(tabUrl(deep, "conversations"), deep)
  assert.equal(tabUrl(deep, "usage"), "https://site.example/admin?tab=usage")
  assert.equal(
    tabUrl("https://site.example/admin", "claims"),
    "https://site.example/admin?tab=claims",
  )
})

test("audit filters become query parameters", () => {
  const p = auditParams(
    { login: "@alice", action: "gpt", since: "2026-09-01", until: "2026-09-01" },
    42,
    50,
  )
  assert.equal(p.get("login"), "alice")
  assert.equal(p.get("action"), "gpt")
  assert.equal(Number(p.get("until")) - Number(p.get("since")), 86_400_000)
  assert.equal(p.get("before_id"), "42")
  assert.equal(auditParams({}).toString(), "limit=100")
})

test("rows read as sentences", () => {
  assert.equal(describe({ action: "auth.login", target: null }), "signed in")
  assert.equal(
    describe({ action: "device.create", target: "bec-main" }),
    "registered device bec-main",
  )
  assert.equal(
    describe({ action: "api.POST", target: "/api/calendar/events", status: 201 }),
    "api.POST /api/calendar/events → 201",
  )
  assert.equal(
    describe({
      action: "gpt.message",
      target: "c1",
      detail: { model: "claude-sonnet-5", input: 1200, output: 300, mentions: ["a"] },
    }),
    "asked Hafezi GPT in c1 · claude-sonnet-5 · 1.5k tokens · @1",
  )
  assert.equal(
    describe({ action: "gpt.share", target: "c1", detail: { grantee: "*" } }),
    "shared chat c1 with the whole lab",
  )
  assert.equal(
    describe({ action: "admin.profile.approve", target: "ada" }),
    "approved the People page claim of ada",
  )
})

test("token and budget formatting", () => {
  assert.equal(formatTokens(950), "950")
  assert.equal(formatTokens(12_345), "12k")
  assert.equal(formatTokens(2_500_000), "2.5M")
  assert.equal(parseBudget(""), null)
  assert.equal(parseBudget("2M"), 2_000_000)
  assert.equal(parseBudget("500k"), 500_000)
  assert.equal(parseBudget("1,500,000"), 1_500_000)
  assert.throws(() => parseBudget("lots"))
  assert.equal(budgetUsed({ monthly_tokens: null, input: 1, output: 1 }), null)
  assert.equal(budgetUsed({ monthly_tokens: 100, input: 30, output: 20 }), 0.5)
})

test("arrow keys wrap around the tabs; Home and End go to the ends", () => {
  assert.equal(nextTab(3, "ArrowRight", 4), 0)
  assert.equal(nextTab(0, "ArrowLeft", 4), 3)
  assert.equal(nextTab(2, "Home", 4), 0)
  assert.equal(nextTab(1, "End", 4), 3)
  assert.equal(nextTab(1, "Enter", 4), null)
})
