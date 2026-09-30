import assert from "node:assert/strict"
import test from "node:test"
import { folderActions } from "./folder-tools.js"
import { intentOf } from "./uploads/model.js"

test("an automatic folder page offers an upload to its own folder of the vault", () => {
  const [upload, ...others] = folderActions({ folder: "notes/group-meeting-2026-09-29" })
  assert.equal(others.length, 0)
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
