import assert from "node:assert/strict"
import test from "node:test"
import { editAttributes } from "./pageTools"

test("a page made from a vault file names that file, its blob and its history", () => {
  assert.deepEqual(
    editAttributes("resources/code/sweep--and--fit", {
      title: "Sweep",
      edit_repo: "vault-private",
      edit_path: "code/Sweep & fit.qmd",
      edit_sha: "0123456789abcdef0123456789abcdef01234567",
    }),
    {
      "data-edit-path": "code/Sweep & fit.qmd",
      "data-history": "/resources/code/sweep--and--fit.history.json",
      "data-edit-repo": "vault-private",
      "data-edit-sha": "0123456789abcdef0123456789abcdef01234567",
    },
  )
  assert.deepEqual(
    editAttributes("index", {
      edit_repo: "vault",
      edit_path: "content/index.md",
      edit_sha: "ab",
      edit_note: "generated",
    }),
    {
      "data-edit-path": "content/index.md",
      "data-history": "/index.history.json",
      "data-edit-repo": "vault",
      "data-edit-sha": "ab",
      "data-edit-note": "generated",
    },
  )
  assert.equal(
    editAttributes("resources/code/guide/intro", {
      edit_path: "code/guide/intro.nb",
      edit_mode: "scratchpad",
    })["data-edit-mode"],
    "scratchpad",
  )
})

test("a page the site makes whole has no file to edit or history", () => {
  assert.deepEqual(editAttributes("people/index", { title: "People" }), {})
  assert.deepEqual(editAttributes("tags/code", undefined), {})
  assert.deepEqual(editAttributes("x", { edit_path: 3, edit_repo: "vault" }), {})
})
