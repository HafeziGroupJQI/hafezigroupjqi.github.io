import assert from "node:assert/strict"
import test from "node:test"
import {
  dayLabel,
  describe,
  feedUrl,
  filtersOf,
  leaderboardRedirect,
  lineCounts,
  pageHref,
  searchOf,
  stateLabel,
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

test("the old Contributions tab's addresses go to the Leaderboard", () => {
  assert.equal(leaderboardRedirect("?view=contributions&period=week"), "/leaderboard?period=week")
  assert.equal(leaderboardRedirect("?view=contributions&period=month"), "/leaderboard?period=month")
  assert.equal(leaderboardRedirect("?view=contributions"), "/leaderboard")
  assert.equal(leaderboardRedirect("?view=contributions&period=year"), "/leaderboard")
  // The feed's own addresses stay.
  assert.equal(leaderboardRedirect(""), null)
  assert.equal(leaderboardRedirect("?user=ada"), null)
  assert.equal(leaderboardRedirect("?view=changes"), null)
})
