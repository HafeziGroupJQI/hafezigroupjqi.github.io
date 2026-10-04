import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import yaml from "yaml"
import { prepareUnified } from "../prepare-unified.mjs"
import { normalizeSnapshot } from "./policy.mjs"
import {
  checkCoverage,
  folderAcl,
  markPages,
  pageVaultPath,
  readSnapshot,
  writeBuildVersion,
} from "./snapshot.mjs"

const SNAPSHOT = {
  version: 3,
  groups: { "optical-rl": { logins: ["anishgoyal1108"], people: ["people/lida-xu"] } },
  rules: [{ id: "r1", pattern: "projects/optical-rl/", allow: ["group:optical-rl"], deny: [] }],
}

const front = (file) =>
  yaml.parse(fs.readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---\n/)[1])

test("the snapshot is vault-private's .hafezi/acl.json, or no rules without one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hafezi-acl-"))
  try {
    assert.deepEqual(readSnapshot(root), { version: 0, groups: {}, rules: [] })
    fs.mkdirSync(path.join(root, ".hafezi"))
    fs.writeFileSync(path.join(root, ".hafezi", "acl.json"), JSON.stringify(SNAPSHOT))
    const snapshot = readSnapshot(root)
    assert.equal(snapshot.version, 3)
    assert.equal(snapshot.rules[0].id, "r1")
    fs.writeFileSync(path.join(root, ".hafezi", "acl.json"), "{")
    assert.throws(() => readSnapshot(root), /not a valid access rules snapshot/)
    const file = writeBuildVersion(path.join(root, "out"), snapshot)
    assert.equal(fs.readFileSync(file, "utf8"), '{"version":3}')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("every restricted vault file must be covered by a rule", () => {
  const overlay = [
    { repo: "vault-optical-rl", path: "projects/optical-rl/notes/x.md" },
    { repo: "vault-optical-rl", path: "projects/optical-rl/assets/plot.png" },
  ]
  checkCoverage(normalizeSnapshot(SNAPSHOT), overlay)
  checkCoverage(normalizeSnapshot(undefined), [])
  assert.throws(
    () => checkCoverage(normalizeSnapshot(undefined), overlay),
    /not covered by an access rule[\s\S]*vault-optical-rl: projects\/optical-rl\/notes\/x\.md/,
  )
})

test("pages are marked by their own file's vault path, folders by theirs", () => {
  const snapshot = normalizeSnapshot(SNAPSHOT)
  assert.equal(folderAcl(snapshot, "projects/optical-rl"), "r1")
  assert.equal(folderAcl(snapshot, "projects/optical-rl/notes"), "r1")
  assert.equal(folderAcl(snapshot, "projects"), null)
  assert.equal(pageVaultPath({ vault_source: "a/b.qmd" }, "a/b.md"), "a/b.qmd")
  assert.equal(pageVaultPath({ rendered_from: "resources/a/b.ipynb" }, "a/b.md"), "a/b.ipynb")
  assert.equal(pageVaultPath({}, "a/b.md"), "a/b.md")
})

test("prepare-unified marks restricted pages unlisted with their rule, and the notebooks' later", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "hafezi-acl-prepare-"))
  const publicRoot = path.join(fixture, "public")
  const privateRoot = path.join(fixture, "private")
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  write(path.join(publicRoot, "index.md"), "---\ntitle: Home\n---\nHome")
  write(path.join(privateRoot, "notes", "open.md"), "---\ntitle: Open\n---\nOpen")
  write(
    path.join(privateRoot, "projects", "optical-rl", "notes", "meeting.md"),
    "---\ntitle: Meeting\nrendered_from: projects/optical-rl/notes/meeting.qmd\n---\nSecret",
  )
  write(path.join(privateRoot, "projects", "optical-rl", "notes", "plain.md"), "No front matter")
  let built
  try {
    const acl = normalizeSnapshot(SNAPSHOT)
    built = prepareUnified(publicRoot, privateRoot, yaml, { acl })
    const resources = path.join(built.output, "resources")
    const meeting = front(path.join(resources, "projects/optical-rl/notes/meeting.md"))
    assert.equal(meeting.unlisted, true)
    assert.equal(meeting.acl, "r1")
    assert.equal(meeting.vault_source, "projects/optical-rl/notes/meeting.qmd")
    const plain = path.join(resources, "projects/optical-rl/notes/plain.md")
    assert.deepEqual(front(plain), { unlisted: true, acl: "r1" })
    assert.match(fs.readFileSync(plain, "utf8"), /---\nNo front matter$/)
    const open = front(path.join(resources, "notes/open.md"))
    assert.equal(open.acl, undefined)
    assert.equal(open.unlisted, undefined)

    // A notebook's page, made later in the build, is marked by its notebook's path.
    const notebook = path.join(resources, "projects/optical-rl/notes/run.md")
    fs.writeFileSync(
      notebook,
      "---\ntitle: Run\nrendered_from: resources/projects/optical-rl/notes/run.ipynb\n---\nCells",
    )
    assert.equal(markPages(built.output, acl, yaml), 1)
    assert.equal(front(notebook).acl, "r1")
    assert.equal(markPages(built.output, acl, yaml), 0)
    assert.equal(markPages(built.output, normalizeSnapshot(undefined), yaml), 0)

    // A restricted Bases page isn't supported: it would list its rows to every member.
    fs.rmSync(built.stage, { recursive: true, force: true })
    built = null
    write(path.join(privateRoot, "projects", "optical-rl", "runs.base"), "views: []\n")
    assert.throws(
      () => prepareUnified(publicRoot, privateRoot, yaml, { acl }),
      /runs\.base: a Bases page can't be restricted/,
    )
  } finally {
    if (built) fs.rmSync(built.stage, { recursive: true, force: true })
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})
