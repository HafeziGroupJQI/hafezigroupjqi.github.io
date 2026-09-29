import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { recentChanges } from "./recent-changes.mjs"
import { recentPage } from "./site-model.mjs"

// A vault with its own history: content/ inside a git work tree, as the deploy checks it out.
function vault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recent-"))
  const content = path.join(dir, "content")
  fs.mkdirSync(path.join(content, "people"), { recursive: true })
  let clock = Date.UTC(2026, 8, 1)
  const git = (args, author = ["Anish Goyal", "anish@example.com"]) => {
    const when = new Date((clock += 3600_000)).toISOString()
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
  }
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(content, file)), { recursive: true })
    fs.writeFileSync(path.join(content, file), text)
  }
  const commit = (message, author) => {
    git(["add", "-A"])
    git(["commit", "-q", "-m", message], author)
  }
  git(["init", "-q", "-b", "main"])
  return { dir, content, write, commit }
}

const records = [
  { slug: "index", fm: { title: "Hafezi Group" } },
  { slug: "news/launch", fm: { title: "Lab launch" } },
  { slug: "people/ada-lovelace", fm: { title: "Ada Lovelace", type: "person", github: "ada" } },
  { slug: "people/grace-hopper", fm: { title: "Grace Hopper", type: "person", github: "grace" } },
]

test("pages newest-changed first, once each, with who changed them", () => {
  const v = vault()
  v.write("index.md", "home")
  v.write("news/launch.md", "a")
  v.write("news/old.md", "gone soon")
  v.commit("start")
  v.write("people/ada-lovelace.md", "ada")
  v.write("people/grace-hopper.md", "grace")
  v.commit("people")
  v.write("news/launch.md", "b")
  v.write("assets/people/ada.jpg", "jpg")
  fs.rmSync(path.join(v.content, "news/old.md"))
  v.commit("news", ["Anish Goyal", "anish@example.com"])
  // A member's own Settings edit, committed under their login.
  v.write("people/ada-lovelace.md", "ada 2")
  v.commit("update people/ada-lovelace", ["ada", "ada@users.noreply.github.com"])
  // Several members' edits in one hourly commit, under the site's name.
  v.write("people/grace-hopper.md", "grace 2")
  v.commit("update 2 people pages", [
    "hafezi members site",
    "hafezi-members@users.noreply.github.com",
  ])

  const changes = recentChanges(v.content, records)
  assert.deepEqual(
    changes.map(({ slug, by }) => [slug, by]),
    [
      ["people/grace-hopper", "Grace Hopper"],
      ["people/ada-lovelace", "Ada Lovelace"],
      ["news/launch", "Anish Goyal"],
      ["index", "Anish Goyal"],
    ],
  )
  assert.equal(changes[0].title, "Grace Hopper")
  assert.match(changes[0].at, /^2026-09-01T/)
  assert.equal(recentChanges(v.content, records, { limit: 2 }).length, 2)
})

test("no history is an empty list, not a failed build", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"))
  assert.deepEqual(recentChanges(dir, records), [])
  assert.match(recentPage([]), /No changes to list yet/)
})

test("the page lists each change with its section, author and day", () => {
  const html = recentPage([
    { slug: "people/ada-lovelace", title: "Ada <Lovelace>", by: "Ada", at: "2026-09-28T19:00:00Z" },
    { slug: "index", title: "Hafezi Group", by: "Anish", at: "2026-09-27T10:00:00Z" },
  ])
  assert.match(html, /<a class="internal" href="people\/ada-lovelace">Ada &lt;Lovelace&gt;<\/a>/)
  assert.match(html, /<span class="recent-section">People<\/span>/)
  assert.match(html, /by Ada · <time datetime="2026-09-28T19:00:00Z">2026-09-28<\/time>/)
  // The homepage is the site root, not /index.
  assert.match(html, /href="\.\/">Hafezi Group<\/a> <span class="recent-section">Pages<\/span>/)
})
