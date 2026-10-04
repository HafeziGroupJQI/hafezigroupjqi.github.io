import assert from "node:assert/strict"
import test from "node:test"
import {
  MEMBER_COLUMNS,
  MEMBERS_SENTENCE,
  PAGE_COLUMNS,
  contributionsHref,
  memberCells,
  memberTitles,
  membersNotes,
  membersUrl,
  pageCells,
  pageTitle,
  pagesSentence,
  pagesUrl,
  scoreTitle,
  stateOf,
  stateSearch,
} from "./model.js"

test("the address picks the tab and the period", () => {
  assert.deepEqual(stateOf(""), { tab: "members", period: "all" })
  assert.deepEqual(stateOf("?tab=pages&period=week"), { tab: "pages", period: "week" })
  // Values the page doesn't offer are dropped.
  assert.deepEqual(stateOf("?tab=scores&period=year"), { tab: "members", period: "all" })
  assert.equal(stateSearch({ tab: "members", period: "all" }), "")
  assert.equal(stateSearch({ tab: "members", period: "month" }), "?period=month")
  assert.equal(stateSearch({ tab: "pages", period: "week" }), "?tab=pages&period=week")
  for (const search of ["", "?period=month", "?tab=pages&period=week", "?tab=pages"])
    assert.equal(stateSearch(stateOf(search)), search)
  assert.equal(membersUrl("week"), "/api/leaderboard?period=week")
  assert.equal(pagesUrl("all"), "/api/leaderboard/pages?period=all")
  assert.equal(contributionsHref("ada"), "/recent?user=ada")
})

// The Worker's row for Ada in worker/test/leaderboard.test.ts's worked example.
const ada = {
  rank: 1,
  login: "ada",
  author: "Ada Lovelace",
  files: 1,
  changes: 3,
  pages_created: 0,
  added: 0,
  removed: 0,
  score: 3.8,
  contributions: 3.8,
  karma: 0.8,
  reach: 1.7,
  total: 7.1,
  credited_votes: 0.75,
  credited_readers: 3,
  last_at: Date.UTC(2026, 9, 4, 16),
}

test("a member's row shows the Total beside the parts it adds up", () => {
  const cells = memberCells(ada, "en-US")
  assert.equal(cells.length, MEMBER_COLUMNS.length)
  const text = cells.map((cell) => (typeof cell === "string" ? cell : cell.text))
  assert.deepEqual(text.slice(0, 8), ["1", "Ada Lovelace", "7.1", "3.8", "0.8", "1.7", "1", "3"])
  assert.match(text[8], /Oct 4, 2026/)
  assert.deepEqual(cells[1], {
    text: "Ada Lovelace",
    href: "/recent?user=ada",
    title: "Ada Lovelace's contributions",
  })
  const titles = memberTitles(ada)
  assert.equal(titles.total, "3.8 + 2 × 0.8 + 1.7 = 7.1")
  assert.equal(titles.contributions, "1 files + 2 × √2 repeat changes = 3.8")
  assert.match(titles.karma, /: 0\.75$/)
  assert.equal(titles.reach, "√3 members who read those pages, by the same shares = 1.7")
  // A member with credit and no changes in the period has no last change.
  const bo = { ...ada, login: "bo", author: "", files: 0, changes: 0, last_at: null }
  const boText = memberCells(bo).map((cell) => (typeof cell === "string" ? cell : cell.text))
  assert.equal(boText[1], "bo")
  assert.equal(boText[8], "—")
  assert.equal(
    scoreTitle({ files: 2, changes: 5, score: 5.5 }),
    "2 files + 2 × √3 repeat changes = 5.5",
  )
})

test("a top page goes by its title from the content index, or its name", () => {
  const titles = {
    "resources/notes/meeting": { title: "Group meeting" },
    "resources/notes/index": { title: "Notes" },
    index: { title: "Hafezi Group" },
  }
  assert.equal(pageTitle("resources/notes/meeting", titles), "Group meeting")
  assert.equal(pageTitle("resources/notes", titles), "Notes")
  assert.equal(pageTitle("index", titles), "Hafezi Group")
  assert.equal(pageTitle("index"), "Home")
  assert.equal(pageTitle("resources/code/fast-fourier"), "fast fourier")
  const page = {
    rank: 2,
    path: "resources/notes",
    href: "/resources/notes",
    score: 3,
    up: 4,
    down: 1,
    viewers: 12,
  }
  const cells = pageCells(page, titles)
  assert.equal(cells.length, PAGE_COLUMNS.length)
  assert.deepEqual(cells, [
    "2",
    { text: "Notes", href: "/resources/notes", title: "/resources/notes" },
    { text: "3", title: "4 up, 1 down" },
    "4",
    "1",
    "12",
  ])
})

test("says what the numbers mean", () => {
  assert.match(MEMBERS_SENTENCE, /^Total = Contributions \+ 2 × Karma \+ Reach\./)
  assert.match(membersNotes(50), /more than 50 files/)
  assert.match(pagesSentence("week"), /a week earlier needs ten times/)
  assert.match(pagesSentence("all"), /a year earlier/)
})
