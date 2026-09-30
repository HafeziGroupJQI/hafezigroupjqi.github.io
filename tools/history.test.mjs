import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  SITE_AUTHOR,
  creditOf,
  fileHistories,
  pageHistories,
  parseLog,
  people,
  readLog,
} from "./history.mjs"

// A vault with its own history (content/ inside a git work tree, as the deploy checks it out),
// one commit an hour from 2026-09-01 01:00 UTC.
function vault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-"))
  let clock = Date.UTC(2026, 8, 1)
  const git = (args, author = ["Anish Goyal", "anish@example.com"]) => {
    if (args[0] === "commit") clock += 3600_000
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
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), text)
  }
  const commit = (message, author) => {
    git(["add", "-A"])
    git(["commit", "-q", "-m", message], author)
    return git(["rev-parse", "HEAD"])
  }
  git(["init", "-q", "-b", "main"])
  const append = (file, text) => fs.appendFileSync(path.join(dir, file), text)
  return { dir, git, write, append, commit, rm: (file) => fs.rmSync(path.join(dir, file)) }
}

const records = [
  { slug: "index", fm: { title: "Hafezi Group" } },
  { slug: "people/ada-lovelace", fm: { title: "Ada Lovelace", type: "person", github: "Ada" } },
  { slug: "people/grace-hopper", fm: { title: "Grace Hopper", type: "person", github: "grace" } },
  { slug: "people/alumni/alan-turing", fm: { title: "Alan Turing", type: "person" } },
]

// create, edit, rename, delete, a binary file, a member's own edit and a site batch commit.
function story() {
  const v = vault()
  const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
  v.write("content/notes/a.md", lines(10))
  v.write("content/notes/gone.md", "soon gone\n")
  v.write("content/assets/photo.png", Buffer.from([0, 1, 2, 255, 0]))
  v.write("content/people/ada-lovelace.md", "ada\n")
  v.write("content/people/grace-hopper.md", "grace\n")
  const start = v.commit("start")
  v.write("content/notes/a.md", lines(10).replace("line 3\n", "line three\nline 3b\n"))
  const edit = v.commit("edit a")
  v.git(["mv", "content/notes/a.md", "content/notes/moved.md"])
  v.rm("content/notes/gone.md")
  const move = v.commit("move a, drop gone")
  v.append("content/notes/moved.md", "more\n")
  const own = v.commit("ada's own edit", ["ada", "12345+Ada@users.noreply.github.com"])
  v.write("content/people/ada-lovelace.md", "ada 2\n")
  v.write("content/people/grace-hopper.md", "grace 2\n")
  const batch = v.commit("update 2 people pages from the members site settings", [
    SITE_AUTHOR,
    "hafezi-members@users.noreply.github.com",
  ])
  return { ...v, start, edit, move, own, batch }
}

test("reads each commit's files, renames and line counts, newest first", () => {
  const v = story()
  const log = readLog(path.join(v.dir, "content"))
  assert.equal(log.prefix, "content/")
  assert.equal(fs.realpathSync(log.root), fs.realpathSync(v.dir))
  assert.deepEqual(
    log.commits.map((c) => c.subject),
    [
      "update 2 people pages from the members site settings",
      "ada's own edit",
      "move a, drop gone",
      "edit a",
      "start",
    ],
  )
  const [batch, own, move, edit, start] = log.commits
  assert.deepEqual(edit.parents, [v.start])
  assert.deepEqual(start.parents, [])
  assert.equal(edit.at, Date.UTC(2026, 8, 1, 2))
  assert.match(edit.date, /^2026-09-01T02:00:00/)
  assert.deepEqual(edit.files, [
    { status: "M", path: "content/notes/a.md", from: null, added: 2, removed: 1 },
  ])
  assert.deepEqual(
    move.files.map((f) => [f.status, f.from, f.path, f.added, f.removed]),
    [
      ["D", null, "content/notes/gone.md", 0, 1],
      ["R", "content/notes/a.md", "content/notes/moved.md", 0, 0],
    ],
  )
  // Only pages are counted in lines.
  assert.deepEqual(
    start.files.find((f) => f.path.endsWith(".png")),
    { status: "A", path: "content/assets/photo.png", from: null, added: null, removed: null },
  )
  assert.equal(own.email, "12345+Ada@users.noreply.github.com")
  assert.equal(batch.files.length, 2)
})

test("follows a page back through its rename, and credits each change to its person", () => {
  const v = story()
  const known = people(records)
  const histories = fileHistories(readLog(v.dir).commits, known)
  const moved = histories.get("content/notes/moved.md")
  assert.deepEqual(
    moved.map((r) => [r.kind, r.path, r.from, r.author, r.login, r.added, r.removed]),
    [
      ["edit", "content/notes/moved.md", null, "Ada Lovelace", "Ada", 1, 0],
      ["rename", "content/notes/moved.md", "content/notes/a.md", "Anish Goyal", null, 0, 0],
      ["edit", "content/notes/a.md", null, "Anish Goyal", null, 2, 1],
      ["new", "content/notes/a.md", null, "Anish Goyal", null, 10, 0],
    ],
  )
  assert.deepEqual(moved[0], {
    commit: v.own,
    parent: v.move,
    date: moved[0].date,
    author: "Ada Lovelace",
    login: "Ada",
    page: "people/ada-lovelace",
    summary: "ada's own edit",
    kind: "edit",
    path: "content/notes/moved.md",
    from: null,
    added: 1,
    removed: 0,
  })
  // The old name has no history of its own; a deleted file keeps its deletion.
  assert.equal(histories.get("content/notes/a.md"), undefined)
  assert.deepEqual(
    histories.get("content/notes/gone.md").map((r) => r.kind),
    ["delete", "new"],
  )
  // The site's batch commit goes to each page's person.
  assert.deepEqual(
    ["ada-lovelace", "grace-hopper"].map(
      (name) => histories.get(`content/people/${name}.md`)[0].author,
    ),
    ["Ada Lovelace", "Grace Hopper"],
  )
})

test("credits noreply addresses, logins and names; never an email", () => {
  const known = people(records)
  const credit = (name, email, file = "content/notes/x.md") =>
    creditOf({ name, email }, file, known)
  assert.deepEqual(credit("someone", "ada@users.noreply.github.com"), {
    login: "Ada",
    name: "Ada Lovelace",
  })
  // A login with no People page keeps its git name.
  assert.deepEqual(credit("Newcomer", "99+newbie@users.noreply.github.com"), {
    login: "newbie",
    name: "Newcomer",
  })
  // The Settings publish commits under the member's login; people also commit under their name.
  assert.deepEqual(credit("grace", "grace@example.com"), { login: "grace", name: "Grace Hopper" })
  assert.deepEqual(credit("Grace Hopper", "gh@example.com"), {
    login: "grace",
    name: "Grace Hopper",
  })
  assert.deepEqual(credit("Anish Goyal", "anish@example.com"), {
    login: null,
    name: "Anish Goyal",
  })
  // The site's own commits: each People page's photo too, else the site itself.
  const site = (file) => credit(SITE_AUTHOR, "hafezi-members@users.noreply.github.com", file)
  assert.equal(site("content/assets/people/grace-hopper.jpg").name, "Grace Hopper")
  assert.equal(site("content/people/alumni/alan-turing.md").name, SITE_AUTHOR)
  assert.deepEqual(site("content/index.md"), { login: null, name: SITE_AUTHOR })
})

test("keys page histories by vault and path, capped, with no email in them", () => {
  const v = story()
  const histories = pageHistories([{ repo: "vault", dir: path.join(v.dir, "content") }], records, {
    pages: (file) => file.endsWith(".md"),
    limit: 3,
  })
  assert.deepEqual(Object.keys(histories).sort(), [
    "vault:content/notes/gone.md",
    "vault:content/notes/moved.md",
    "vault:content/people/ada-lovelace.md",
    "vault:content/people/grace-hopper.md",
  ])
  assert.equal(histories["vault:content/notes/moved.md"].revisions.length, 3)
  assert.equal(histories["vault:content/notes/moved.md"].more, true)
  assert.equal(histories["vault:content/notes/gone.md"].more, false)
  assert.doesNotMatch(JSON.stringify(histories), /@/)
  // A folder outside any work tree has no history.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"))
  assert.deepEqual(pageHistories([{ repo: "vault", dir: bare }], records), {})
})

test("a shallow clone's oldest commit lists no files, rather than every file as new", () => {
  const v = story()
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "shallow-"))
  const run = spawnSync(
    "git",
    ["-c", "safe.directory=*", "clone", "-q", "--depth", "2", `file://${v.dir}`, clone],
    { encoding: "utf8" },
  )
  assert.equal(run.status, 0, run.stderr)
  const log = readLog(clone)
  assert.deepEqual(
    log.commits.map((c) => [c.subject, c.files.length]),
    [
      ["update 2 people pages from the members site settings", 2],
      ["ada's own edit", 0],
    ],
  )
})

test("parses an empty history and a merge without files", () => {
  assert.deepEqual(parseLog(""), [])
  const [merge] = parseLog("\x1eabc\x1fp1 p2\x1fAda\x1fa@x\x1f1\x1f1970-01-01T00:00:01Z\x1fmerge\0")
  assert.deepEqual(merge.parents, ["p1", "p2"])
  assert.deepEqual(merge.files, [])
})
