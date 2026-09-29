import assert from "node:assert/strict"
import test from "node:test"
import { exportItems, pageStem } from "./menu.js"

const ids = (groups) => groups.map((group) => [group.label, group.items.map((item) => item.id)])

test("a page downloads as its Markdown source or as Quarto", () => {
  assert.deepEqual(ids(exportItems({ source: "/resources/onboarding/git.md" })), [
    ["Download", ["source", "quarto"]],
  ])
  assert.deepEqual(
    exportItems({ source: "/lab-facilities.md" })[0].items.map((item) => item.label),
    ["Markdown (.md)", "Quarto (.qmd)"],
  )
})

test("a Quarto page's Quarto is its own source; a Wolfram page's download is the notebook", () => {
  assert.deepEqual(
    ids(exportItems({ source: "/resources/code/sweep.md", rendered: "sweep.qmd" })),
    [["Download", ["rendered", "source"]]],
  )
  assert.deepEqual(ids(exportItems({ source: "/resources/code/ring.md", rendered: "Ring.NB" })), [
    ["Download", ["rendered"]],
  ])
  assert.deepEqual(exportItems({ source: null }), [])
})

test("downloads are named after the page's file, or its folder for an index page", () => {
  assert.equal(pageStem("/resources/onboarding/git.md"), "git")
  assert.equal(pageStem("/resources/code/index.md"), "code")
  assert.equal(pageStem("/index.md"), "index")
  assert.equal(pageStem("/people/Tom%C3%A1s-Lee.md"), "Tomás-Lee")
})
