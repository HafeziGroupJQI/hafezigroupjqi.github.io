import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import PageHistory, { historyPath, pageHistory, vaultFile } from "./index.js"

const revision = {
  commit: "a".repeat(40),
  parent: "b".repeat(40),
  date: "2026-09-29T00:06:42Z",
  author: "Anish Goyal",
  login: "anishgoyal1108",
  summary: "update people/anish-goyal from the members site settings",
  kind: "edit",
  path: "content/people/anish-goyal.md",
  from: null,
  added: 3,
  removed: 3,
}

test("only pages with a file in a vault get a history, next to their HTML", () => {
  const frontmatter = { edit_repo: "vault", edit_path: "content/people/anish-goyal.md" }
  assert.equal(
    historyPath("/out", { slug: "people/anish-goyal", frontmatter }),
    path.join("/out", "people/anish-goyal.history.json"),
  )
  // Pages the site makes whole (indexes, tags, folders) have no file of their own.
  assert.equal(
    historyPath("/out", { slug: "people/index", frontmatter: { title: "People" } }),
    null,
  )
  assert.equal(historyPath("/out", { slug: "tags/code" }), null)
  assert.equal(vaultFile({ edit_repo: "elsewhere", edit_path: "a.md" }), null)
  assert.deepEqual(vaultFile({ ...frontmatter, edit_sha: "c".repeat(40) }), {
    repo: "vault",
    path: "content/people/anish-goyal.md",
    sha: "c".repeat(40),
  })
})

test("a page's history is its file's revisions, or none", () => {
  const histories = {
    "vault:content/people/anish-goyal.md": { revisions: [revision], more: true },
  }
  const frontmatter = { edit_repo: "vault", edit_path: "content/people/anish-goyal.md" }
  assert.deepEqual(pageHistory(frontmatter, histories), {
    repo: "vault",
    path: "content/people/anish-goyal.md",
    sha: null,
    revisions: [revision],
    more: true,
  })
  // A file git has no history for (not committed yet) has an empty one, not a missing file.
  assert.deepEqual(
    pageHistory({ edit_repo: "vault-private", edit_path: "notes/new.md" }, histories),
    { repo: "vault-private", path: "notes/new.md", sha: null, revisions: [], more: false },
  )
})

test("a restricted vault's page names that vault's repository on GitHub", () => {
  const vaults = [
    { repo: "vault-private", prefix: "" },
    { repo: "vault-optical-rl", prefix: "projects/optical-rl/" },
  ]
  const restricted = { edit_repo: "vault-private", edit_path: "projects/optical-rl/notes/x.qmd" }
  assert.equal(pageHistory(restricted, {}, vaults).github, "HafeziGroupJQI/vault-optical-rl")
  assert.equal(pageHistory(restricted, {}, vaults).repo, "vault-private")
  const own = { edit_repo: "vault-private", edit_path: "projects/index.md" }
  assert.equal(pageHistory(own, {}, vaults).github, undefined)
  const open = { edit_repo: "vault", edit_path: "content/people/anish-goyal.md" }
  assert.equal(pageHistory(open, {}, vaults).github, undefined)
})

test("the emitter writes each page's history from the build's histories", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-history-"))
  const saved = process.env.SITE_HISTORY
  try {
    process.env.SITE_HISTORY = path.join(root, "history.json")
    fs.writeFileSync(
      process.env.SITE_HISTORY,
      JSON.stringify({
        "vault:content/people/anish-goyal.md": { revisions: [revision], more: false },
      }),
    )
    const output = path.join(root, "out")
    const frontmatter = { edit_repo: "vault", edit_path: "content/people/anish-goyal.md" }
    const content = [
      [{}, { data: { slug: "people/anish-goyal", frontmatter } }],
      [{}, { data: { slug: "tags/people", frontmatter: {} } }],
    ]
    const written = []
    for await (const file of PageHistory().emit({ argv: { output } }, content)) written.push(file)
    assert.deepEqual(written, [path.join(output, "people/anish-goyal.history.json")])
    const history = JSON.parse(fs.readFileSync(written[0], "utf8"))
    assert.deepEqual(history.revisions, [revision])
    assert.equal(history.repo, "vault")
  } finally {
    if (saved === undefined) delete process.env.SITE_HISTORY
    else process.env.SITE_HISTORY = saved
    fs.rmSync(root, { recursive: true, force: true })
  }
})
