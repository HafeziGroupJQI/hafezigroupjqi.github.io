import assert from "node:assert/strict"
import test from "node:test"
import { editAction, editUrl } from "./link.js"
import {
  cleanSummary,
  draftStatus,
  dueAt,
  editIntent,
  lineSeparator,
  othersNotice,
  sendHint,
  sendLabel,
  startingText,
  storageKey,
} from "./model.js"

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 8, 29, 14, 20)

test("a page's Edit opens its own file in the editor, never the page the site made", () => {
  const page = "/resources/code/bend-optimization"
  assert.deepEqual(
    editAction(
      {
        editRepo: "vault-private",
        editPath: "code/Bend optimization.qmd",
        editSha: "abc1234",
        history: "/x.history.json",
      },
      page,
    ),
    {
      label: "Edit",
      title: "Edit Bend optimization.qmd, this page's source",
      href: "/edit?repo=vault-private&path=code%2FBend+optimization.qmd&page=%2Fresources%2Fcode%2Fbend-optimization&sha=abc1234",
    },
  )
  // An index that lists its folder says that list is the site's.
  assert.match(
    editAction(
      { editRepo: "vault-private", editPath: "code/index.md", editNote: "generated" },
      "/resources/code/",
    )?.href ?? "",
    /note=generated/,
  )
  // A public page's file is in the public vault.
  assert.equal(
    editAction({ editRepo: "vault", editPath: "content/people/ada.md" }, "/people/ada")?.href,
    "/edit?repo=vault&path=content%2Fpeople%2Fada.md&page=%2Fpeople%2Fada",
  )
  // A Wolfram notebook is edited in the Scratchpad; a drawing is replaced whole, not edited here.
  assert.deepEqual(
    editAction(
      { editRepo: "vault-private", editPath: "code/guide/01.nb", editMode: "scratchpad" },
      page,
    ),
    {
      label: "Edit in Scratchpad",
      title: "Opens a copy of the notebook in your Scratchpad",
      href: "/scratchpad?fork=code%2Fguide%2F01.nb",
    },
  )
  assert.equal(
    editAction({ editRepo: "vault-private", editPath: "a.excalidraw.md", editMode: "file" }, page),
    null,
  )
  assert.equal(editAction({}, page), null)
  assert.equal(
    editUrl({ repo: "vault", path: "content/people/ada.md" }),
    "/edit?repo=vault&path=content%2Fpeople%2Fada.md",
  )
})

test("the editor reads what it was opened with", () => {
  assert.deepEqual(
    editIntent("?repo=vault&path=content%2Findex.md&page=%2F&sha=ab&note=generated"),
    {
      repo: "vault",
      path: "content/index.md",
      page: "/",
      sha: "ab",
      note: "generated",
    },
  )
  assert.deepEqual(editIntent(""), { repo: null, path: null, page: null, sha: null, note: null })
})

test("a file keeps its own line separator and a summary is one line", () => {
  assert.equal(lineSeparator("a\r\nb\r\n"), "\r\n")
  assert.equal(lineSeparator("a\nb\n"), "\n")
  assert.equal(cleanSummary("  fix\n the   date "), "fix the date")
  assert.equal(cleanSummary(undefined), "")
  assert.equal(storageKey("vault", "content/a.md"), "hafezi:edit:vault:content/a.md")
})

test("unsaved text in this browser comes back only over the version it was typed on", () => {
  const main = { sha: "m1", text: "main\n" }
  assert.deepEqual(startingText({ main, draft: null }, null), { text: "main\n", restored: false })
  assert.deepEqual(startingText({ main, draft: null }, { text: "typed\n", base: "m1", at: 5 }), {
    text: "typed\n",
    restored: true,
  })
  // Typed over another version of the file: not brought back over this one.
  assert.equal(
    startingText({ main, draft: null }, { text: "typed\n", base: "m0", at: 5 }).restored,
    false,
  )
  const draft = { text: "draft\n", base_sha: "m1", edited_at: 10 }
  assert.equal(
    startingText({ main, draft }, { text: "typed\n", base: "m1", at: 5 }).text,
    "draft\n",
  )
  assert.equal(
    startingText({ main, draft }, { text: "typed\n", base: "m1", at: 20 }).text,
    "typed\n",
  )
})

test("a draft's state and when a send goes in read as sentences", () => {
  assert.equal(dueAt(NOW), Date.UTC(2026, 8, 29, 16, 0))
  assert.equal(draftStatus(null), "Not saved yet.")
  assert.match(
    draftStatus({ status: "editing", edited_at: NOW }, NOW, "en-US"),
    /^Draft saved Sep 29, .*, not sent yet\.$/,
  )
  assert.match(
    draftStatus({ status: "open", unsent: false, due_at: NOW + HOUR, review: null }, NOW, "en-US"),
    /^Sent: it goes in at .*, in 1 h 0 min, once the vault's check passes\.$/,
  )
  assert.match(
    draftStatus({ status: "open", unsent: false, due_at: NOW + HOUR, review: ["x"] }, NOW),
    /an admin merges it/,
  )
  assert.match(draftStatus({ status: "open", unsent: true }, NOW), /send it again/)
  assert.match(draftStatus({ status: "failed", detail: { message: "no title" } }), /\(no title\)/)
  assert.match(sendHint({ review: null }, NOW, "en-US"), /goes in at .*, in 1 h 40 min if/)
  assert.equal(
    sendHint({ review: "its code cells run when the site builds" }, NOW),
    "Sending opens a pull request; an admin merges it after checking it, since its code cells run when the site builds.",
  )
  // A public page's edit is published: straight into the public vault in its hour.
  assert.match(
    sendHint({ repo: "vault", review: null }, NOW, "en-US"),
    /^Published now, it goes into the public vault at .*, in 1 h 40 min, and the public page shows it/,
  )
  assert.match(
    draftStatus({ repo: "vault", status: "open", unsent: false, due_at: NOW + HOUR }, NOW),
    /^Published: it goes into the public vault at .*\. Until then only you see it\.$/,
  )
  assert.match(
    draftStatus({ repo: "vault", status: "open", unsent: true }, NOW),
    /publish it again/,
  )
  assert.match(draftStatus({ repo: "vault", status: "conflict" }), /publish it again/)
  assert.equal(sendLabel("vault", null), "Publish")
  assert.equal(sendLabel("vault", { status: "open" }), "Publish the new version")
  assert.equal(sendLabel("vault-private", { status: "editing", pull: null }), "Send")
  assert.equal(
    sendLabel("vault-private", { status: "open", pull: { number: 1 } }),
    "Send the new version",
  )
})

test("others' drafts of the same file are named, with when they go in", () => {
  assert.equal(othersNotice([]), null)
  assert.match(
    othersNotice([{ login: "eve", status: "open", due_at: NOW + HOUR }], NOW, "en-US"),
    /^Another member has a draft of this file too: eve \(sent, goes in at .*\)\./,
  )
  assert.match(
    othersNotice(
      [
        { login: "eve", status: "editing" },
        { login: "bob", status: "failed" },
      ],
      NOW,
    ),
    /Other members have .*: eve \(not sent yet\) and bob \(failed\)\./,
  )
})
