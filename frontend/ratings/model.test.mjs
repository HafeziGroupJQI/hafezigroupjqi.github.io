import assert from "node:assert/strict"
import test from "node:test"
import { nextVote, pagePath, rateable, ratingText, ratingUrl, withVote } from "./model.js"

test("keys a page by its address as the Worker does", () => {
  assert.equal(pagePath("/"), "index")
  assert.equal(pagePath("/index.html"), "index")
  assert.equal(pagePath("/resources/notes/"), "resources/notes")
  assert.equal(pagePath("/resources/notes/index"), "resources/notes")
  assert.equal(pagePath("/resources/notes.html"), "resources/notes")
  assert.equal(pagePath("/people/ada%20lovelace"), "people/ada lovelace")
  assert.equal(pagePath("/notes/reindex"), "notes/reindex")
  assert.equal(pagePath("/bad%E0%A4%A"), "bad%E0%A4%A")
  assert.equal(ratingUrl("people/ada lovelace"), "/api/ratings?path=people%2Fada+lovelace")
})

test("a button votes, or takes back the vote it already is", () => {
  assert.equal(nextVote(0, 1), 1)
  assert.equal(nextVote(1, 1), 0)
  assert.equal(nextVote(1, -1), -1)
  assert.equal(nextVote(-1, -1), 0)
})

test("shows the vote at once, whatever it was before", () => {
  const rating = { path: "a", score: 3, up: 5, down: 2, mine: 0, viewers: 9, views7: 4 }
  assert.deepEqual(withVote(rating, 1), { ...rating, score: 4, up: 6, mine: 1 })
  assert.deepEqual(withVote(rating, -1), { ...rating, score: 2, down: 3, mine: -1 })
  const up = withVote(rating, 1)
  assert.deepEqual(withVote(up, -1), { ...rating, score: 2, down: 3, mine: -1 })
  assert.deepEqual(withVote(up, 0), rating)
  // Every path back gives the rating it started from.
  for (const first of [-1, 0, 1])
    for (const second of [-1, 0, 1])
      assert.deepEqual(withVote(withVote(withVote(rating, first), second), 0), rating)
})

test("says what each part means, for screen readers and tooltips", () => {
  const text = ratingText({ score: -1, up: 1, down: 2, mine: -1, viewers: 1, views7: 0 })
  assert.equal(text.up, "Upvote this page")
  assert.equal(text.down, "Remove your downvote")
  assert.equal(text.score, "-1")
  assert.equal(text.scoreTitle, "Score -1: 1 upvote, 2 downvotes")
  assert.equal(text.readers, "1 reader")
  assert.equal(text.readersTitle, "1 member has read this page, 0 in the last 7 days")
  assert.equal(
    ratingText({ score: 0, up: 0, down: 0, mine: 1, viewers: 3, views7: 2 }).up,
    "Remove your upvote",
  )
})

test("rates pages with a source, never the tool pages", () => {
  assert.equal(rateable({ hasSource: true, isToolPage: false }), true)
  assert.equal(rateable({ hasSource: true, isToolPage: true }), false)
  assert.equal(rateable({ hasSource: false, isToolPage: false }), false)
})
