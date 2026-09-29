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

test("a Jupyter notebook's page downloads as the notebook, or as Quarto or Markdown made from it", () => {
  const groups = exportItems({ source: "/resources/code/01_ring.md", rendered: "01_ring.ipynb" })
  assert.deepEqual(ids(groups), [["Download", ["rendered", "notebook-qmd", "notebook-md", "pdf"]]])
  assert.deepEqual(
    groups[0].items.map((item) => item.label),
    ["Notebook (.ipynb)", "Quarto (.qmd)", "Markdown with figures (.md)", "Save as PDF…"],
  )
})

test("with a Google client, a page also saves to Drive: as a Google Doc, and as its file", () => {
  assert.deepEqual(ids(exportItems({ source: "/lab-facilities.md", drive: true })), [
    ["Download", ["source", "quarto", "pdf"]],
    ["Save to Google Drive", ["drive-doc", "drive-source"]],
  ])
  const notebook = exportItems({
    source: "/resources/code/01_ring.md",
    rendered: "01_ring.ipynb",
    drive: true,
  })
  assert.deepEqual(notebook[1].items, [
    { id: "drive-doc", label: "As a Google Doc" },
    { id: "drive-rendered", label: "As the notebook (.ipynb), for Colab" },
  ])
  assert.deepEqual(
    ids(exportItems({ source: "/resources/code/sweep.md", rendered: "sweep.qmd", drive: true }))[1],
    ["Save to Google Drive", ["drive-doc", "drive-rendered"]],
  )
  // Before Google's window asks, the menu says what for, and links the privacy page.
  assert.equal(notebook[1].note.link.href, "/privacy")
  assert.equal(exportItems({ source: "/lab-facilities.md" })[0].note, undefined)
  // No client ID (config.js): no Drive items at all.
  assert.equal(exportItems({ source: "/lab-facilities.md", drive: false }).length, 1)
})

test("downloads are named after the page's file, or its folder for an index page", () => {
  assert.equal(pageStem("/resources/onboarding/git.md"), "git")
  assert.equal(pageStem("/resources/code/index.md"), "code")
  assert.equal(pageStem("/index.md"), "index")
  assert.equal(pageStem("/people/Tom%C3%A1s-Lee.md"), "Tomás-Lee")
})
