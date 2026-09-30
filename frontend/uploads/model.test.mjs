import assert from "node:assert/strict"
import test from "node:test"
import {
  changeLabel,
  crumbs,
  draftForPage,
  draftName,
  fileProblem,
  folderOf,
  formatBytes,
  intentOf,
  joinPath,
  replaceDraft,
  replaceProblem,
  settleLabel,
  statusLabel,
  statusTarget,
  uploadsUrl,
  withConflicts,
} from "./model.js"

const HOUR = 3_600_000
const draft = (fields) => ({
  id: "0123456789ab",
  status: "editing",
  note: "",
  created_at: Date.UTC(2026, 8, 29, 14, 5),
  changes: [],
  review: null,
  unsent: false,
  ...fields,
})

test("sizes read in bytes, KB and MB", () => {
  assert.equal(formatBytes(1), "1 byte")
  assert.equal(formatBytes(900), "900 bytes")
  assert.equal(formatBytes(340 * 1024), "340 KB")
  assert.equal(formatBytes(1.25 * 1024 * 1024), "1.3 MB")
})

test("each change reads as what it does", () => {
  assert.equal(
    changeLabel({ action: "add", path: "notes/a.pdf", size: 2048 }),
    "Add notes/a.pdf (2 KB)",
  )
  assert.equal(
    changeLabel({ action: "replace", path: "notes/a.md", size: 10 }),
    "Replace notes/a.md (10 bytes)",
  )
  assert.equal(
    changeLabel({ action: "rename", from: "notes/a.pdf", path: "files/a.pdf", size: null }),
    "Move notes/a.pdf to files/a.pdf",
  )
  assert.equal(
    changeLabel({ action: "delete", path: "files/x.csv", size: null }),
    "Delete files/x.csv",
  )
})

test("a draft is named by its note's first line, else when it was started", () => {
  assert.equal(
    draftName(draft({ note: "Scans of the lab book\nand more" })),
    "Scans of the lab book",
  )
  assert.equal(draftName(draft({ note: "x".repeat(100) })).length, 80)
  assert.match(draftName(draft({}), "en-US"), /^Draft started Sep 29, \d+:05 [AP]M$/)
  // A page edit is named by its summary, else its file.
  assert.equal(
    draftName(draft({ kind: "edit", summary: "Fix the date", path: "notes/a.md" })),
    "Fix the date",
  )
  assert.equal(
    draftName(draft({ kind: "edit", summary: null, path: "notes/a.md" })),
    "Edit of notes/a.md",
  )
})

test("a draft's status says what happens next", () => {
  const now = Date.UTC(2026, 8, 29, 14, 20)
  const due = Date.UTC(2026, 8, 29, 16, 0)
  assert.equal(statusLabel(draft({})), "Empty: add files, or move or delete some")
  assert.equal(statusLabel(draft({ changes: [{}] })), "Not sent yet")
  assert.match(
    statusLabel(draft({ status: "open", due_at: due, changes: [{}] }), now, "en-US"),
    /^Merges into the vault at \d+:00 [AP]M, in 1 h 40 min, if the vault's check passes$/,
  )
  assert.match(
    statusLabel(draft({ status: "open", due_at: due, review: ["code/a.qmd: runs"] }), now, "en-US"),
    /^Checked, then left for an admin to merge at .*, since something in it runs$/,
  )
  assert.equal(
    statusLabel(draft({ status: "open", due_at: due, unsent: true }), now),
    "Changed since you sent it: send it again (its hour starts over)",
  )
  assert.equal(
    statusLabel(draft({ status: "open", due_at: due, check: { state: "failure" } }), now),
    "The vault's check failed: fix the files and send it again",
  )
  assert.equal(
    statusLabel(
      draft({ status: "open", due_at: due, detail: { message: "waiting for the validate check" } }),
      due + HOUR / 2,
    ),
    "Waiting for the next hourly merge: waiting for the validate check",
  )
  assert.equal(
    statusLabel(draft({ status: "failed" })),
    "The vault's check failed: fix the files and send it again",
  )
  assert.match(statusLabel(draft({ status: "conflict" })), /^Main changed the same files/)
  assert.match(
    statusLabel(draft({ status: "review" })),
    /waiting for an admin to merge it on GitHub/,
  )
  assert.match(
    statusLabel(draft({ status: "merged", merged_at: due }), now, "en-US"),
    /^Merged Sep 29, /,
  )
  assert.equal(
    statusLabel(draft({ status: "discarded", detail: { message: "closed on GitHub" } })),
    "Discarded: closed on GitHub",
  )
})

test("a public page's edit reads as going into the public vault, with no pull request", () => {
  const now = Date.UTC(2026, 8, 29, 14, 20)
  assert.match(
    statusLabel(draft({ kind: "edit", repo: "vault", status: "open", due_at: now + HOUR }), now),
    /^Published: it goes into the public vault at .*\. Until then only you see it$/,
  )
  assert.match(
    statusLabel(draft({ kind: "edit", repo: "vault", status: "conflict" }), now),
    /^The page changed on main since you started/,
  )
})

test("paths split into folders and breadcrumbs", () => {
  assert.equal(folderOf("notes/2026/a.md"), "notes/2026")
  assert.equal(folderOf("a.md"), "")
  assert.equal(joinPath("notes", "a.md"), "notes/a.md")
  assert.equal(joinPath("", "notes"), "notes")
  assert.deepEqual(crumbs("files/equipment"), [
    { name: "vault-private", path: "" },
    { name: "files", path: "files" },
    { name: "equipment", path: "files/equipment" },
  ])
  assert.deepEqual(crumbs(""), [{ name: "vault-private", path: "" }])
})

test("files the site won't take are caught before they're sent", () => {
  const state = { types: ["pdf", "md"], limits: { file: 25 * 1024 * 1024 } }
  assert.equal(fileProblem({ name: "a.PDF", size: 10 }, state), null)
  assert.equal(
    fileProblem({ name: "page.html", size: 10 }, state),
    "page.html: .html files can't be uploaded",
  )
  assert.equal(
    fileProblem({ name: "Makefile", size: 10 }, state),
    "Makefile: files without an extension can't be uploaded",
  )
  assert.equal(fileProblem({ name: "a.md", size: 0 }, state), "a.md is empty")
  assert.equal(
    fileProblem({ name: "a.pdf", size: 30 * 1024 * 1024 }, state),
    "a.pdf is 30.0 MB; a file can be at most 25.0 MB",
  )
})

test("a file is replaced only by a file of its own type", () => {
  const state = { types: ["pdf", "md"], limits: { file: 1024 } }
  assert.equal(replaceProblem({ name: "new.PDF", size: 10 }, "notes/old.pdf", state), null)
  assert.equal(
    replaceProblem({ name: "new.md", size: 10 }, "notes/old.pdf", state),
    "notes/old.pdf can only be replaced by a .pdf file",
  )
  assert.equal(
    replaceProblem({ name: "new.pdf", size: 0 }, "notes/old.pdf", state),
    "new.pdf is empty",
  )
})

test("a page's tools open /uploads on the newest unsent draft", () => {
  assert.equal(uploadsUrl("replace", "notes/a b.pdf"), "/uploads?replace=notes%2Fa+b.pdf")
  assert.deepEqual(intentOf("?replace=notes%2Fa+b.pdf"), {
    draft: null,
    replace: "notes/a b.pdf",
    rename: null,
    folder: null,
  })
  assert.deepEqual(intentOf("?draft=0123456789ab"), {
    draft: "0123456789ab",
    replace: null,
    rename: null,
    folder: null,
  })
  // A folder page's "Upload to this folder": the folder, never a path out of the vault.
  assert.equal(
    intentOf("?folder=notes%2Fgroup-meeting-2026-09-29").folder,
    "notes/group-meeting-2026-09-29",
  )
  assert.equal(intentOf("?folder=/files/Nonlinear+code/").folder, "files/Nonlinear code")
  assert.equal(intentOf("?folder=notes/../../etc").folder, null)
  assert.equal(intentOf("?folder=.git/hooks").folder, null)
  assert.equal(intentOf("?folder=").folder, null)
  const drafts = [draft({ id: "a", status: "open" }), draft({ id: "b" }), draft({ id: "c" })]
  assert.equal(draftForPage(drafts).id, "b")
  assert.equal(draftForPage([draft({ status: "open" })]), null)
  // A page edit is changed in the editor, never added to.
  assert.equal(draftForPage([draft({ kind: "edit" })]), null)
})

test("messages go beside the open draft, else at the top of the page", () => {
  assert.equal(statusTarget(null), "page")
  assert.equal(statusTarget(draft({ status: "open" })), "draft")
  assert.equal(statusTarget(draft({ status: "merged" })), "draft")
})

test("a changed draft replaces its card, keeping the others where they are", () => {
  const a = draft({ id: "a", changes: [] })
  const b = draft({ id: "b" })
  const staged = { ...a, changes: [{ action: "add", path: "notes/x.pdf", size: 10 }], bytes: 10 }
  assert.deepEqual(replaceDraft([a, b], staged), [staged, b])
  assert.deepEqual(replaceDraft([b], staged), [staged, b])
})

test("a held page edit says who settles it, and a conflict to settle says whose it is", () => {
  const conflict = {
    id: "c1",
    draft: "d1",
    login: "rai",
    author: "Rai",
    path: "content/a.md",
    first_login: "anish",
    first_author: "Anish",
    opened_at: Date.UTC(2026, 8, 29, 14, 0),
  }
  const [held, plain] = withConflicts(
    [
      { id: "d1", kind: "edit", repo: "vault-private", status: "conflict", changes: [] },
      { id: "d2", kind: "upload", repo: "vault-private", status: "conflict", changes: [] },
    ],
    [conflict],
  )
  assert.equal(statusLabel(held), "Waiting for Anish or an admin to settle it")
  assert.match(statusLabel(plain), /Main changed the same files/)
  assert.match(
    settleLabel({ ...conflict, you_first: true }, "en-US"),
    /^Rai's change to content\/a\.md conflicts with yours \(since Sep 29, /,
  )
  assert.match(settleLabel(conflict, "en-US"), /conflicts with Anish's/)
  assert.match(
    settleLabel({ ...conflict, first_login: null }, "en-US"),
    /a change that went in first/,
  )
})
