import assert from "node:assert/strict"
import test from "node:test"
import {
  authorHref,
  commitUrl,
  comparable,
  comparableFile,
  comparePair,
  fileHistoryUrl,
  kindLabel,
  lineCounts,
  revisionUrl,
  versionAt,
  versionBefore,
  revertLinks,
} from "./model.js"

const SHA = "27305400641f27926908e3b3f3912eb4a6ca9d26"
const PARENT = "cbfd292b91cd5927b01fb54cbfdae26e094c9fdd"

test("reads public revisions from GitHub and private ones through the Worker", () => {
  assert.equal(
    revisionUrl("vault", SHA, "content/people/anish goyal.md"),
    `https://raw.githubusercontent.com/HafeziGroupJQI/vault/${SHA}/content/people/anish%20goyal.md`,
  )
  assert.equal(
    revisionUrl("vault-private", SHA, "notes/lab meeting.md"),
    `/api/history/file?repo=vault-private&rev=${SHA}&path=notes%2Flab+meeting.md`,
  )
  assert.equal(commitUrl("vault", SHA), `https://github.com/HafeziGroupJQI/vault/commit/${SHA}`)
  assert.equal(
    fileHistoryUrl("vault-private", "code/fit.qmd"),
    "https://github.com/HafeziGroupJQI/vault-private/commits/main/code/fit.qmd",
  )
})

test("knows each revision's file and the one before it, across moves", () => {
  const edit = { kind: "edit", commit: SHA, parent: PARENT, path: "notes/b.md", from: null }
  assert.deepEqual(versionAt(edit), { commit: SHA, path: "notes/b.md" })
  assert.deepEqual(versionBefore(edit), { commit: PARENT, path: "notes/b.md" })
  const move = { ...edit, kind: "rename", from: "notes/a.md" }
  assert.deepEqual(versionBefore(move), { commit: PARENT, path: "notes/a.md" })
  assert.equal(kindLabel(move), "moved from notes/a.md")
  // Nothing before a new file; nothing after a deleted one.
  assert.equal(versionBefore({ ...edit, kind: "new" }), null)
  assert.equal(versionAt({ ...edit, kind: "delete" }), null)
  assert.equal(kindLabel({ kind: "new" }), "created")
  assert.equal(kindLabel({ kind: "delete" }), "deleted")
  assert.equal(kindLabel({ kind: "edit" }), "edited")
  assert.equal(lineCounts({ added: 3, removed: 1 }), "+3 −1")
  assert.equal(lineCounts({ added: null, removed: null }), "")
})

test("compares any two revisions, older first", () => {
  const revisions = ["c", "b", "a"].map((commit) => ({ kind: "edit", commit, path: "x.md" }))
  const pair = [
    { commit: "a", path: "x.md" },
    { commit: "c", path: "x.md" },
  ]
  assert.deepEqual(comparePair(revisions, 2, 0), pair)
  assert.deepEqual(comparePair(revisions, 0, 2), pair)
})

test("links authors to their contributions for members, else to their People page", () => {
  const revision = { login: "anishgoyal1108", page: "people/anish-goyal" }
  assert.equal(authorHref(revision, { members: true }), "/recent?user=anishgoyal1108")
  assert.equal(authorHref(revision), "/people/anish-goyal")
  assert.equal(authorHref({ login: null, page: null }, { members: true }), null)
})

test("compares a notebook as the Quarto document it reads as, not its JSON", () => {
  const notebook = JSON.stringify({
    nbformat: 4,
    metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } },
    cells: [
      { cell_type: "markdown", source: ["# Fit\n", "The data."] },
      {
        cell_type: "code",
        source: "x = 1",
        outputs: [{ output_type: "stream", text: "a long output\n" }],
      },
    ],
  })
  const text = comparable("code/fit.ipynb", notebook)
  assert.match(text, /^---\njupyter:\n {2}kernelspec:\n {4}name: python3/)
  assert.match(text, /# Fit\nThe data\.\n\n```\{python\}\nx = 1\n```\n$/)
  assert.doesNotMatch(text, /a long output/)
  // Pages and notebooks are compared; a Wolfram notebook's history is a list.
  assert.equal(comparableFile("code/fit.qmd"), true)
  assert.equal(comparableFile("code/guide/intro.nb"), false)
  // Anything else, or a notebook that isn't one, as it is.
  assert.equal(comparable("code/broken.ipynb", "{not json"), "{not json")
  assert.equal(comparable("notes/a.md", "# A\n"), "# A\n")
  assert.equal(comparable("notes/a.md", null), "")
})

test("members get Restore and Undo on a page's revisions, where its editor opens", () => {
  const sha = "b".repeat(40)
  const parent = "c".repeat(40)
  const edit = { editRepo: "vault", editPath: "content/a.md" }
  const revision = { commit: sha, parent, path: "content/a.md", kind: "edit" }
  assert.deepEqual(revertLinks(revision, 1, edit, "/a"), [
    {
      label: "Restore this version",
      href: `/edit?repo=vault&path=content%2Fa.md&page=%2Fa&restore=${sha}`,
    },
    {
      label: "Undo this change",
      href: `/edit?repo=vault&path=content%2Fa.md&page=%2Fa&undo=${sha}`,
    },
  ])
  // The newest is the page as it is: nothing to restore, but its change can be undone.
  assert.deepEqual(
    revertLinks(revision, 0, edit).map((link) => link.label),
    ["Undo this change"],
  )
  // A file that moved since is restored from its old name.
  assert.match(
    revertLinks({ ...revision, path: "content/old.md", kind: "rename" }, 2, edit)[0].href,
    /from=content%2Fold\.md$/,
  )
  assert.deepEqual(revertLinks({ ...revision, kind: "delete" }, 1, edit), [])
  assert.deepEqual(revertLinks({ ...revision, kind: "new", parent: null }, 1, edit).length, 1)
  // Notebooks are restored, not undone; a Wolfram notebook or a file replaced whole, neither.
  assert.deepEqual(
    revertLinks(revision, 1, { editRepo: "vault-private", editPath: "x/fit.ipynb" }).map(
      (l) => l.label,
    ),
    ["Restore this version"],
  )
  assert.deepEqual(revertLinks(revision, 1, { ...edit, editMode: "scratchpad" }), [])
  assert.deepEqual(revertLinks(revision, 1, { ...edit, editMode: "file" }), [])
  assert.deepEqual(revertLinks(revision, 1, {}), [])
  assert.deepEqual(revertLinks({ ...revision, commit: "abc" }, 1, edit), [])
})
