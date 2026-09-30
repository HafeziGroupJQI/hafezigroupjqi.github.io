import test from "node:test"
import assert from "node:assert/strict"
import {
  nextTab,
  auditParams,
  budgetUsed,
  codeQuery,
  describe,
  diffLines,
  formatTokens,
  parseBudget,
  sessionRuns,
  tabUrl,
  usageByDay,
  usageLabel,
  uploadsWaiting,
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
  assert.equal(
    describe({ action: "uploads.rename", target: "notes/a.pdf", detail: { to: "files/a.pdf" } }),
    "staged a move of notes/a.pdf to files/a.pdf",
  )
  assert.equal(
    describe({ action: "uploads.send", target: "0123456789ab", detail: { pull: 4 } }),
    "sent upload draft 0123456789ab as pull request #4",
  )
  assert.equal(
    describe({ action: "admin.uploads.discard", target: "0123456789ab", detail: { login: "ada" } }),
    "discarded the upload draft 0123456789ab of ada",
  )
  assert.equal(
    describe({ action: "edit.send", target: "content/people/ada.md" }),
    "sent an edit of content/people/ada.md",
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

test("a month's usage by day: a column per model and source, the latest day first", () => {
  const haiku = { model: "claude-haiku-4-5-20251001", label: "Haiku 4.5", source: "completion" }
  const sonnet = { model: "claude-sonnet-5", label: "Sonnet 5", source: "agent" }
  const { columns, rows } = usageByDay([
    { ...haiku, day: "2031-02-01", cost_usd: 0.25 },
    { ...sonnet, day: "2031-02-03", cost_usd: 3 },
    { ...haiku, day: "2031-02-03", cost_usd: 0.5 },
  ])
  assert.deepEqual(
    columns.map((c) => c.label),
    ["Sonnet 5 · Coding agent", "Haiku 4.5 · Ghost text"],
  )
  assert.deepEqual(
    rows.map((r) => [r.day, r.cost_usd, Object.keys(r.cells).length]),
    [
      ["2031-02-03", 3.5, 2],
      ["2031-02-01", 0.25, 1],
    ],
  )
  assert.equal(rows[1].cells[columns[1].key].cost_usd, 0.25)
  assert.equal(usageLabel({ model: "offline", source: "chat" }), "offline · Site chat")
})

test("the Code tab's deep link stays on it, and a member stays chosen between member tabs", () => {
  const deep = "https://site.example/admin?tab=code&member=ada&view=files&commit=abc1234"
  assert.equal(tabUrl(deep, "code"), deep)
  assert.equal(tabUrl(deep, "audit"), "https://site.example/admin?tab=audit")
  assert.equal(
    tabUrl(deep, "conversations"),
    "https://site.example/admin?tab=conversations&member=ada",
  )
  assert.equal(
    tabUrl("https://site.example/admin?tab=conversations&member=ada&c=c_1", "code"),
    "https://site.example/admin?tab=code&member=ada",
  )
})

test("a Code tab read's query: the member, then its paging", () => {
  assert.equal(codeQuery("ada"), "login=ada")
  const q = new URLSearchParams(
    codeQuery("ada", { since: "2026-09-01", before: "49:2", limit: 200 }),
  )
  assert.equal(q.get("since"), String(new Date("2026-09-01T00:00:00").getTime()))
  assert.equal(q.get("before"), "49:2")
  assert.equal(q.get("limit"), "200")
  assert.equal(codeQuery("ada", { before: 0, offset: 50 }), "login=ada&before=0&offset=50")
})

test("IPython inputs group into runs of one session", () => {
  const runs = sessionRuns([
    { session: 49, line: 2, at: 10 },
    { session: 49, line: 1, at: 10 },
    { session: 46, line: 1, at: 5 },
  ])
  assert.deepEqual(
    runs.map((run) => [run.session, run.at, run.entries.map((e) => e.line)]),
    [
      [49, 10, [2, 1]],
      [46, 5, [1]],
    ],
  )
  assert.deepEqual(sessionRuns([]), [])
})

test("a diff reads line by line: stat, file headers, hunks, additions, removals", () => {
  const diff = [
    " notes/rings.py | 2 +-",
    " 1 file changed, 1 insertion(+), 1 deletion(-)",
    "",
    "diff --git a/members/ada/notes/rings.py b/members/ada/notes/rings.py",
    "index 1..2 100644",
    "--- a/members/ada/notes/rings.py",
    "+++ b/members/ada/notes/rings.py",
    "@@ -1 +1 @@",
    "-q = 1",
    "--- a removed line that looks like a header",
    "+q = 2",
    " context",
    "\\ No newline at end of file",
    "",
  ].join("\n")
  assert.deepEqual(
    diffLines(diff).map((line) => line.kind),
    [
      "stat",
      "stat",
      "stat",
      "file",
      "meta",
      "meta",
      "meta",
      "hunk",
      "del",
      "del",
      "add",
      "context",
      "meta",
    ],
  )
})

test("admins' code reads read as sentences", () => {
  assert.equal(
    describe({ action: "admin.compute.ipython", target: "ada" }),
    "read the IPython history of ada",
  )
  assert.equal(
    describe({ action: "admin.compute.files", target: "ada", detail: { rev: "0123456789abcdef" } }),
    "read the file history of ada · commit 0123456",
  )
})

test("the Uploads tab counts drafts to merge by hand and conflicts to settle", () => {
  const drafts = [{ status: "review" }, { status: "open" }, { status: "conflict" }]
  assert.equal(uploadsWaiting(drafts), 1)
  assert.equal(uploadsWaiting(drafts, [{ id: "a" }, { id: "b" }]), 3)
  assert.equal(uploadsWaiting([], []), 0)
})
