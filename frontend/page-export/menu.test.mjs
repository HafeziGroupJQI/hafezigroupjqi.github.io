import assert from "node:assert/strict"
import test from "node:test"
import { exportItems, pageStem } from "./menu.js"

const ids = (groups) => groups.map((group) => [group.label, group.items.map((item) => item.id)])

test("a page downloads as its Markdown source, as Quarto, or as a PDF from the print dialog", () => {
  assert.deepEqual(ids(exportItems({ source: "/resources/onboarding/git.md" })), [
    ["Download", ["source", "quarto", "pdf"]],
  ])
  assert.deepEqual(
    exportItems({ source: "/lab-facilities.md" })[0].items.map((item) => item.label),
    ["Markdown (.md)", "Quarto (.qmd)", "Save as PDF…"],
  )
})

test("a Quarto page's Quarto is its own source; a Wolfram page's download is the notebook", () => {
  assert.deepEqual(
    ids(exportItems({ source: "/resources/code/sweep.md", rendered: "sweep.qmd" })),
    [["Download", ["rendered", "source", "pdf"]]],
  )
  assert.deepEqual(ids(exportItems({ source: "/resources/code/ring.md", rendered: "Ring.NB" })), [
    ["Download", ["rendered", "pdf"]],
  ])
  assert.deepEqual(ids(exportItems({ source: null })), [["Download", ["pdf"]]])
})

test("downloads are named after the page's file, or its folder for an index page", () => {
  assert.equal(pageStem("/resources/onboarding/git.md"), "git")
  assert.equal(pageStem("/resources/code/index.md"), "code")
  assert.equal(pageStem("/index.md"), "index")
  assert.equal(pageStem("/people/Tom%C3%A1s-Lee.md"), "Tomás-Lee")
})
