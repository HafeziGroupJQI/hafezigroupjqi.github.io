import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  STATEMENT_MAX,
  importRows,
  insertStatements,
  isContent,
  literal,
  pageSlug,
  unrecorded,
} from "./changes-import.mjs"

// A git work tree with the given files, committed in turn: [[message, author, {path: text|null}]].
function repo(commits) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changes-"))
  let clock = Date.UTC(2026, 8, 1)
  const git = (args, author = ["Anish Goyal", "anish@example.com"]) => {
    const when = new Date(clock).toISOString()
    const run = spawnSync("git", ["-c", "safe.directory=*", "-C", dir, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: author[0],
        GIT_AUTHOR_EMAIL: author[1],
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_NAME: "c",
        GIT_COMMITTER_EMAIL: "c@example.com",
        GIT_COMMITTER_DATE: when,
      },
    })
    assert.equal(run.status, 0, run.stderr)
    return run.stdout.trim()
  }
  git(["init", "-q", "-b", "main"])
  const shas = []
  for (const [message, author, files] of commits) {
    clock += 3600_000
    for (const [file, text] of Object.entries(files)) {
      const target = path.join(dir, file)
      if (text === null) fs.rmSync(target)
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        if (typeof text === "object") git(["mv", text.from, file])
        else fs.writeFileSync(target, text)
      }
    }
    git(["add", "-A"])
    git(["commit", "-q", "-m", message], author)
    shas.push(git(["rev-parse", "HEAD"]))
  }
  return { dir, shas }
}

const ADA = "---\ntitle: Ada Lovelace\ntype: person\ngithub: ada\n---\n\nAda.\n"

test("imports each content file of both vaults' commits, credited, and nothing else", () => {
  const vault = repo([
    [
      "start",
      undefined,
      {
        "content/index.md": "home\n",
        "content/people/ada-lovelace.md": ADA,
        "content/assets/people/ada-lovelace.jpg": "jpg",
        "tools/validate.mjs": "\n",
        ".github/workflows/validate.yml": "on: push\n",
      },
    ],
    [
      "ada's page, by ada",
      ["ada", "ada@users.noreply.github.com"],
      { "content/people/ada-lovelace.md": ADA + "More.\n" },
    ],
  ])
  const vaultPrivate = repo([
    [
      "notes",
      ["Ada Lovelace", "ada@example.com"],
      {
        "notes/meeting.md": "minutes\n",
        "code/fit.qmd": "fit\n",
        "code/run.ipynb": "{}\n",
        "README.md": "readme\n",
        "_freeze/code/fit/x.json": "{}\n",
        "tools/validate.mjs": "\n",
      },
    ],
    ["move it", undefined, { "notes/2026/meeting.md": { from: "notes/meeting.md" } }],
    ["drop the notebook", undefined, { "code/run.ipynb": null }],
  ])
  const rows = importRows({
    vault: path.join(vault.dir, "content"),
    "vault-private": vaultPrivate.dir,
  })
  const brief = (row) => [
    row.repo,
    row.kind,
    row.path,
    row.from_path,
    row.slug,
    row.author,
    row.login,
  ]
  assert.deepEqual(rows.map(brief), [
    [
      "vault",
      "edit",
      "content/people/ada-lovelace.md",
      null,
      "people/ada-lovelace",
      "Ada Lovelace",
      "ada",
    ],
    ["vault", "new", "content/assets/people/ada-lovelace.jpg", null, null, "Anish Goyal", null],
    ["vault", "new", "content/index.md", null, "index", "Anish Goyal", null],
    [
      "vault",
      "new",
      "content/people/ada-lovelace.md",
      null,
      "people/ada-lovelace",
      "Anish Goyal",
      null,
    ],
    ["vault-private", "delete", "code/run.ipynb", null, null, "Anish Goyal", null],
    [
      "vault-private",
      "rename",
      "notes/2026/meeting.md",
      "notes/meeting.md",
      "resources/notes/2026/meeting",
      "Anish Goyal",
      null,
    ],
    ["vault-private", "new", "code/fit.qmd", null, "resources/code/fit", "Ada Lovelace", "ada"],
    ["vault-private", "new", "code/run.ipynb", null, "resources/code/run", "Ada Lovelace", "ada"],
    [
      "vault-private",
      "new",
      "notes/meeting.md",
      null,
      "resources/notes/meeting",
      "Ada Lovelace",
      "ada",
    ],
  ])
  const [edit] = rows
  assert.deepEqual(
    { ...edit, at: typeof edit.at },
    {
      at: "number",
      login: "ada",
      author: "Ada Lovelace",
      repo: "vault",
      path: "content/people/ada-lovelace.md",
      from_path: null,
      slug: "people/ada-lovelace",
      kind: "edit",
      state: "merged",
      summary: "ada's page, by ada",
      commit_sha: vault.shas[1],
      added: 1,
      removed: 0,
      source: "git",
    },
  )
  assert.doesNotMatch(JSON.stringify(rows), /@/)
})

test("imports commits made on github to a restricted vault under its own repo, once", () => {
  const vault = repo([["start", undefined, { "content/people/ada-lovelace.md": ADA }]])
  const vaultPrivate = repo([["notes", undefined, { "notes/a.md": "a\n" }]])
  const restricted = repo([
    [
      "the restricted vault",
      undefined,
      {
        "README.md": "readme\n",
        ".github/workflows/validate.yml": "on: push\n",
        "projects/optical-rl/notes/meeting.qmd": "minutes\n",
      },
    ],
    [
      "ada's analysis, straight on github",
      ["ada", "ada@users.noreply.github.com"],
      {
        "projects/optical-rl/files/run.py": "print(1)\n",
        "projects/optical-rl/notes/meeting.qmd": "minutes, corrected\n",
      },
    ],
  ])
  const vaults = {
    vault: path.join(vault.dir, "content"),
    "vault-private": vaultPrivate.dir,
    restricted: [{ repo: "vault-optical-rl", prefix: "projects/optical-rl/", dir: restricted.dir }],
  }
  const rows = importRows(vaults)
  const brief = (row) => [row.repo, row.kind, row.path, row.slug, row.login, row.commit_sha]
  assert.deepEqual(rows.filter((row) => row.repo !== "vault").map(brief), [
    ["vault-private", "new", "notes/a.md", "resources/notes/a", null, vaultPrivate.shas[0]],
    [
      "vault-optical-rl",
      "new",
      "projects/optical-rl/files/run.py",
      null,
      "ada",
      restricted.shas[1],
    ],
    [
      "vault-optical-rl",
      "edit",
      "projects/optical-rl/notes/meeting.qmd",
      "resources/projects/optical-rl/notes/meeting",
      "ada",
      restricted.shas[1],
    ],
    [
      "vault-optical-rl",
      "new",
      "projects/optical-rl/notes/meeting.qmd",
      "resources/projects/optical-rl/notes/meeting",
      null,
      restricted.shas[0],
    ],
  ])
  // A rerun after the import finds every commit in D1, and sends nothing.
  const recorded = new Set(rows.map((row) => `${row.repo} ${row.commit_sha}`))
  assert.deepEqual(unrecorded(importRows(vaults), recorded), [])
  // A new commit to the restricted vault alone is all a later run sends.
  const later = unrecorded(
    importRows(vaults),
    new Set([...recorded].filter((key) => key !== `vault-optical-rl ${restricted.shas[1]}`)),
  )
  assert.deepEqual(
    later.map((row) => row.path),
    ["projects/optical-rl/files/run.py", "projects/optical-rl/notes/meeting.qmd"],
  )
  assert.equal(isContent("vault-optical-rl", "README.md", "projects/optical-rl/"), false)
  assert.equal(isContent("vault-optical-rl", "notes/x.md", "projects/optical-rl/"), false)
})

test("knows which vault files are the site's content, and their pages", () => {
  assert.equal(isContent("vault", "content/news/a.md"), true)
  assert.equal(isContent("vault", "content/.obsidian/app.json"), false)
  assert.equal(isContent("vault", "README.md"), false)
  assert.equal(isContent("vault-private", "files/data.csv"), true)
  assert.equal(isContent("vault-private", "code/course/README.md"), false)
  assert.equal(isContent("vault-private", "gpt/skills/x/SKILL.md"), false)
  assert.equal(pageSlug("vault", "content/people/index.md"), "people/index")
  assert.equal(pageSlug("vault", "content/news/News.base"), null)
  assert.equal(pageSlug("vault-private", "code/guide/intro.nb"), "resources/code/guide/intro")
  assert.equal(pageSlug("vault-private", "files/data.csv"), null)
})

test("writes rows as one-line INSERT OR IGNORE statements under D1's limit", () => {
  assert.equal(literal(null), "NULL")
  assert.equal(literal(12), "12")
  assert.equal(literal(Number.NaN), "NULL")
  assert.equal(literal(""), "''")
  assert.equal(literal("ada's page"), "'ada''s page'")
  assert.equal(literal("a\nb\r\n"), "'a' || char(10) || 'b' || char(13) || char(10)")
  const rows = Array.from({ length: 700 }, (_, i) => ({
    at: i,
    author: "Ünïcode ‘quotes’ ".repeat(20),
    repo: "vault",
    path: `content/${i}.md`,
    kind: "new",
    state: "merged",
    summary: "s",
    commit_sha: "c".repeat(40),
    source: "git",
  }))
  const statements = insertStatements(rows)
  assert.ok(statements.length > 3)
  for (const statement of statements) {
    assert.match(statement, /^INSERT OR IGNORE INTO changes \(at, login, author, [^\n]+;$/)
    assert.ok(Buffer.byteLength(statement) <= STATEMENT_MAX)
  }
  assert.equal(statements.join("").match(/'content\/\d+\.md'/g).length, 700)
  assert.deepEqual(insertStatements([]), [])
})

// The Worker's test runs this SQL through D1 twice (worker/test/changes.test.ts): it must be what
// the import writes. UPDATE_FIXTURES=1 rewrites it.
test("the Worker's import fixture is what the import writes", () => {
  const row = (at, path, extra = {}) => ({
    at,
    login: null,
    author: "Anish Goyal",
    repo: "vault",
    path,
    from_path: null,
    slug: null,
    kind: "edit",
    state: "merged",
    summary: "fix the santec laser's range; 1400-1600 nm",
    commit_sha: "b".repeat(40),
    added: 1,
    removed: 1,
    source: "git",
    ...extra,
  })
  const rows = [
    row(1790700000000, "content/lab-facilities.md", { slug: "lab-facilities" }),
    row(1790700000000, "content/people/ada-lovelace.md", {
      login: "ada",
      author: "Ada Lovelace",
      slug: "people/ada-lovelace",
    }),
    row(1790600000000, "notes/odd\nname.md", {
      repo: "vault-private",
      kind: "rename",
      from_path: "notes/old.md",
      commit_sha: "d".repeat(40),
      summary: "move a note",
    }),
    // The Worker recorded this one as it merged a member's upload.
    row(1790500000000, "files/data.csv", {
      repo: "vault-private",
      kind: "upload",
      commit_sha: "e".repeat(40),
      added: null,
      removed: null,
      summary: "add files/data.csv by ada lovelace from the members site uploads",
    }),
  ]
  const fixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../worker/test/fixtures/changes-import.sql",
  )
  const sql = insertStatements(rows).join("\n") + "\n"
  if (process.env.UPDATE_FIXTURES) fs.writeFileSync(fixture, sql)
  assert.equal(fs.readFileSync(fixture, "utf8"), sql)
})
