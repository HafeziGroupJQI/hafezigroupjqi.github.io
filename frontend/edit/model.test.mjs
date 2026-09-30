import assert from "node:assert/strict"
import test from "node:test"
import { editAction, editUrl } from "./link.js"
import { diffHtml } from "../page-history/diff.js"
import {
  besideNote,
  cleanSummary,
  conflictWords,
  compareWords,
  draftStatus,
  dueAt,
  editIntent,
  heldNotice,
  lineSeparator,
  movedNotice,
  revertIntent,
  revertNotice,
  othersNotice,
  sendHint,
  sendLabel,
  sendRefusal,
  settleNotice,
  settleWords,
  stackWords,
  staleNotice,
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
      conflict: null,
      restore: null,
      undo: null,
      from: null,
    },
  )
  assert.deepEqual(editIntent(""), {
    repo: null,
    path: null,
    page: null,
    sha: null,
    note: null,
    conflict: null,
    restore: null,
    undo: null,
    from: null,
  })
  assert.equal(editIntent("?conflict=0123456789ab").conflict, "0123456789ab")
  assert.deepEqual(
    [editIntent("?restore=abc&from=notes%2Fa.md").restore, editIntent("?undo=def").undo],
    ["abc", "def"],
  )
  assert.equal(editIntent("?restore=abc&from=notes%2Fa.md").from, "notes/a.md")
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

test("a save over a newer one made elsewhere says when that one was made", () => {
  assert.match(
    staleNotice({ edited_at: NOW }, "en-US"),
    /^You saved a newer version of this draft somewhere else \(Sep 29, .*\)\. Use that version/,
  )
})

test("a send refused because main changed says whether the changes were merged", () => {
  assert.match(compareWords("rebase", "vault").message, /so we merged them.*then publish\.$/)
  assert.equal(compareWords("rebase", "vault-private").done, "It looks right")
  assert.match(
    compareWords("main", "vault-private").message,
    /keep yours or take theirs.*send it again\.$/,
  )
  assert.equal(compareWords(undefined, "vault").done, "I've taken in their changes")
  assert.match(sendRefusal({ kind: "rebase" }), /We merged the changes/)
  assert.match(sendRefusal({ kind: "main" }), /same lines/)
  assert.match(sendRefusal({ kind: "moved" }), /moved or deleted/)
  assert.equal(sendRefusal({ detail: "no" }), "no")
})

// Names, summaries and page text from another member: the words below are text (index.js and
// conflict.js put them in with textContent), and their change is drawn by diff2html, escaped.
const EVIL = '<img src=x onerror="alert(1)">'

test("the conflict dialog names the other member and when their change goes in", () => {
  const words = conflictWords(
    { with: { author: "Anish", login: "anish", sent_at: NOW - HOUR, due_at: NOW + HOUR } },
    "vault",
    NOW,
    "en-US",
  )
  assert.equal(words.title, "Anish also changed this page")
  assert.match(
    words.line,
    /^Anish published a change at .*\. It goes in at .*\. It changes some of the same lines as yours\.$/,
  )
  assert.equal(
    words.queue,
    "Queue for review: an admin or Anish will settle it. Your change waits until then.",
  )
  assert.match(
    conflictWords({ with: { login: "eve", due_at: 0 } }, "vault-private", NOW).line,
    /^eve sent a change .*the next hourly run/,
  )
  // A name is kept as the text it is.
  assert.equal(
    conflictWords({ with: { author: EVIL } }, "vault", NOW).title,
    `${EVIL} also changed this page`,
  )
})

test("another member's change in the dialog is escaped: nothing in it runs", () => {
  const markup = diffHtml("---\ntitle: A\n---\n\nText.\n", `---\ntitle: A\n---\n\n${EVIL}\n`)
  assert.doesNotMatch(markup, /<img/)
  assert.match(markup, /&lt;img/)
})

test("a held change and a conflict to settle say who settles it", () => {
  assert.equal(
    heldNotice({ first_login: "anish", first_author: "Anish" }),
    "Your change is waiting for Anish or an admin to settle it. Withdraw it to change it yourself.",
  )
  assert.match(heldNotice({ first_login: null }), /waiting for an admin to settle it/)
  assert.equal(
    settleNotice({ author: "Rai", you_first: true, first_login: "anish" }, "anish"),
    "Rai has a change that conflicts with yours.",
  )
  assert.match(
    settleNotice({ author: "Rai", first_login: "anish" }, "owner"),
    /conflicts with one sent before it/,
  )
  assert.equal(
    draftStatus({ status: "conflict", conflict: { first_login: null } }),
    heldNotice({ first_login: null }),
  )
})

test("the settle view speaks to the first editor, or to an admin", () => {
  const detail = (conflict) => ({
    conflict: { author: "Rai", state: "open", ...conflict },
    due_at: NOW + HOUR,
  })
  const first = settleWords(detail({ you_first: true, first_login: "anish" }), NOW, "en-US")
  assert.equal(first.first, "Keep mine")
  assert.equal(first.second, "Take theirs")
  assert.match(first.lines[0], /as you\.$/)
  const admin = settleWords(detail({ first_login: "anish", first_author: "Anish" }), NOW, "en-US")
  assert.equal(admin.first, "Keep the first change")
  assert.equal(admin.second, "Take Rai's")
  assert.equal(admin.closed, "Only Anish or an admin can settle this.")
  assert.match(settleWords(detail({ first_login: null }), NOW).lines[0], /went in first/)
  assert.equal(
    settleWords(detail({ state: "resolved" }), NOW).closed,
    "This conflict is settled already.",
  )
})

test("editing on top of another's change, a moved page and changes beside each other", () => {
  assert.match(
    stackWords({ author: "Anish" }, "vault").message,
    /on top of Anish's version.*Yours goes in after theirs\.$/,
  )
  assert.deepEqual(stackWords({ login: "eve" }, "vault").labels, {
    keep: "Keep mine",
    take: "Take theirs",
  })
  assert.match(movedNotice(), /Copy your text/)
  assert.equal(besideNote([]), "")
  assert.equal(
    besideNote([{ author: "Anish" }, { login: "eve" }]),
    " Anish and eve also changed this page, on other lines: both changes go in.",
  )
})

test("a revert from the History is a full commit sha, restored or undone", () => {
  const rev = "a".repeat(40)
  assert.deepEqual(revertIntent(editIntent(`?restore=${rev}`)), { rev, mode: "restore" })
  assert.deepEqual(revertIntent(editIntent(`?undo=${rev}`)), { rev, mode: "undo" })
  assert.equal(revertIntent(editIntent("?restore=main")), null)
  assert.equal(revertIntent(editIntent("")), null)
  assert.match(
    revertNotice({ mode: "restore", rev, clean: true }),
    /^This is the page as it was at aaaaaaa\./,
  )
  assert.match(
    revertNotice({ mode: "undo", rev, clean: true }),
    /without the change made in aaaaaaa/,
  )
  assert.match(
    revertNotice({ mode: "undo", rev, clean: false }),
    /^This change can't be undone on its own/,
  )
})
