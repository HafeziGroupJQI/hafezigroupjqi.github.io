import assert from "node:assert/strict"
import test from "node:test"
import {
  dayLabel,
  describe,
  feedUrl,
  filtersOf,
  lineCounts,
  pageHref,
  scoreCells,
  SCORE_COLUMNS,
  SCORE_SENTENCE,
  scoreNotes,
  scoresUrl,
  scoreTitle,
  searchOf,
  stateLabel,
  viewOf,
  viewSearch,
} from "./model.js"

test("reads the page's filters from its address and writes them back", () => {
  assert.deepEqual(filtersOf("?user=@Ada&repo=vault-private&kind=edit&state=pending"), {
    user: "Ada",
    repo: "vault-private",
    kind: "edit",
    state: "pending",
  })
  // Values the page doesn't offer are dropped.
  assert.deepEqual(filtersOf("?repo=other&kind=merge&state=sent"), {
    user: "",
    repo: "",
    kind: "",
    state: "",
  })
  assert.equal(searchOf(filtersOf("?kind=upload&user=ada")), "?user=ada&kind=upload")
  assert.equal(searchOf(filtersOf("")), "")
})

test("asks the Worker for a member's contributions, by state group, from a cursor", () => {
  assert.equal(feedUrl(filtersOf("")), "/api/changes")
  assert.equal(
    feedUrl(filtersOf("?user=ada&state=pending&repo=vault"), "1790700000000.42"),
    "/api/changes?login=ada&repo=vault&state=draft%2Csent%2Creview&before=1790700000000.42",
  )
  assert.equal(feedUrl(filtersOf("?state=attention")), "/api/changes?state=failed%2Cconflict")
})

test("says what each change did, to which page or file", () => {
  const titles = { "people/ada-lovelace": { title: "Ada Lovelace" }, index: { title: "Home" } }
  const change = (extra) => ({ path: "content/x.md", slug: null, from: null, ...extra })
  assert.deepEqual(describe(change({ kind: "profile", slug: "people/ada-lovelace" }), titles), {
    verb: "updated",
    text: "Ada Lovelace",
    href: "/people/ada-lovelace",
    after: "in Settings",
  })
  assert.deepEqual(describe(change({ kind: "new", slug: "index" }), titles), {
    verb: "created",
    text: "Home",
    href: "/",
    after: "",
  })
  // A page the content index doesn't know shows its file's name; a file that isn't a page, too.
  assert.equal(describe(change({ kind: "edit", slug: "news/new" }), titles).text, "x.md")
  assert.deepEqual(describe(change({ kind: "new", path: "files/data.csv" }), titles), {
    verb: "added",
    text: "data.csv",
    href: null,
    after: "",
  })
  assert.equal(
    describe(change({ kind: "rename", path: "notes/b.md", from: "notes/a.md" })).verb,
    "moved a.md to",
  )
  // A deleted page has nothing to link to.
  assert.equal(describe(change({ kind: "delete", slug: "news/old" })).href, null)
  assert.equal(pageHref("resources/code/index"), "/resources/code/")
  assert.equal(pageHref("resources/code/fit"), "/resources/code/fit")
})

test("labels states that aren't simply in the vault, and line counts", () => {
  assert.equal(stateLabel("merged"), null)
  assert.equal(stateLabel("review"), "waiting for an admin")
  assert.equal(lineCounts({ added: 12, removed: 3 }), "+12 −3")
  assert.equal(lineCounts({ added: null, removed: null }), "")
})

test("groups changes by day", () => {
  const now = new Date(2026, 8, 29, 15).getTime()
  assert.equal(dayLabel(new Date(2026, 8, 29, 1).getTime(), now), "Today")
  assert.equal(dayLabel(new Date(2026, 8, 28, 23).getTime(), now), "Yesterday")
  assert.equal(dayLabel(new Date(2026, 8, 20, 9).getTime(), now, "en-US"), "Sunday, September 20")
  assert.equal(
    dayLabel(new Date(2025, 11, 31).getTime(), now, "en-US"),
    "Wednesday, December 31, 2025",
  )
})

test("the address picks the tab and the leaderboard's period", () => {
  assert.deepEqual(viewOf(""), { view: "changes", period: "all" })
  assert.deepEqual(viewOf("?user=ada"), { view: "changes", period: "all" })
  assert.deepEqual(viewOf("?view=contributions&period=week"), {
    view: "contributions",
    period: "week",
  })
  // Values the page doesn't offer are dropped.
  assert.deepEqual(viewOf("?view=scores&period=year"), { view: "changes", period: "all" })
  assert.equal(
    viewSearch({ view: "contributions", period: "week" }),
    "?view=contributions&period=week",
  )
  assert.equal(viewSearch({ view: "contributions", period: "all" }), "?view=contributions")
  // The changes tab keeps the feed's filters.
  assert.equal(viewSearch({ view: "changes", period: "week" }, filtersOf("?user=ada")), "?user=ada")
  assert.equal(scoresUrl("month"), "/api/changes/scores?period=month")
})

test("a leaderboard row shows the score beside the numbers it comes from", () => {
  const member = {
    rank: 1,
    login: "ada",
    author: "Ada Lovelace",
    score: 5.5,
    files: 2,
    changes: 5,
    pages_created: 1,
    pages_edited: 3,
    files_added: 1,
    added: 120,
    removed: 7,
    active_days: 4,
    last_at: Date.UTC(2026, 8, 29, 16),
  }
  const cells = scoreCells(member, "en-US")
  assert.equal(cells.length, SCORE_COLUMNS.length)
  assert.deepEqual(cells.slice(0, 10), [
    "1",
    "Ada Lovelace",
    "5.5",
    "2",
    "5",
    "1",
    "3",
    "1",
    "+120 −7",
    "4",
  ])
  assert.match(cells[10], /Sep 29, 2026/)
  assert.equal(scoreCells({ ...member, author: "" })[1], "ada")
  assert.equal(scoreTitle(member), "2 files + 2 × √3 repeat changes = 5.5")
  // The page says the formula in one sentence, and what counts.
  assert.match(SCORE_SENTENCE, /^Score = [^.]+\.$/)
  assert.match(scoreNotes(50), /more than 50 files/)
})
