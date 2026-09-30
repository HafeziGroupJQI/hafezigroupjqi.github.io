import assert from "node:assert/strict"
import test from "node:test"
import { folderActions } from "./folder-tools.js"
import { editIntent } from "./edit/model.js"
import { intentOf } from "./uploads/model.js"

test("an automatic folder page offers an upload to its own folder of the vault", () => {
  const [upload, index, ...others] = folderActions({ folder: "notes/group-meeting-2026-09-29" })
  assert.equal(others.length, 0)
  assert.equal(index.id, "index")
  assert.equal(upload.id, "upload")
  assert.equal(upload.label, "Upload to this folder")
  assert.equal(upload.href, "/uploads?folder=notes%2Fgroup-meeting-2026-09-29")
  // The link is the one /uploads reads.
  assert.equal(
    intentOf(upload.href.slice("/uploads".length)).folder,
    "notes/group-meeting-2026-09-29",
  )
  assert.equal(
    intentOf(folderActions({ folder: "files/rc26/Nonlinear code" })[0].href.split("?")[1]).folder,
    "files/rc26/Nonlinear code",
  )
  // A page with a file of its own has no folder in its tools row.
  assert.deepEqual(folderActions({ source: "/resources/notes/a.md" }), [])
  assert.deepEqual(folderActions({ folder: "" }), [])
})

test("an automatic folder page offers to write the folder's own index page", () => {
  const index = folderActions({ folder: "files/rc26/Nonlinear code" }).find((a) => a.id === "index")
  assert.equal(index.label, "Add an index page")
  assert.equal(index.href, "/edit?new=files%2Frc26%2FNonlinear+code%2Findex.md")
  // The link is the one the editor reads.
  const intent = editIntent(index.href.slice("/edit".length))
  assert.deepEqual(
    [intent.repo, intent.path],
    ["vault-private", "files/rc26/Nonlinear code/index.md"],
  )
})
