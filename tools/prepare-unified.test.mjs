import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import yaml from "yaml"
import { prepareUnified } from "./prepare-unified.mjs"

test("combined content keeps homepage, namespaces private links and aliases, and excludes tooling", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "unified-test-"))
  const publicRoot = path.join(fixture, "public")
  const privateRoot = path.join(fixture, "private")
  let built
  try {
    fs.mkdirSync(publicRoot)
    fs.mkdirSync(path.join(privateRoot, "notes"), { recursive: true })
    fs.mkdirSync(path.join(privateRoot, ".git"))
    fs.writeFileSync(path.join(privateRoot, ".git", "config"), "secret")
    fs.writeFileSync(
      path.join(publicRoot, "index.md"),
      "---\ntitle: Hafezi Group\n---\nPublic introduction",
    )
    fs.writeFileSync(
      path.join(privateRoot, "notes", "test.md"),
      "---\ntitle: Private note\naliases: [old-note]\ntags: [private-tag]\n---\n[[notes/other|Other]]\n[Attachment](file.txt)",
    )
    fs.writeFileSync(
      path.join(privateRoot, "notes", "other.md"),
      "---\ntitle: Other\n---\nOther note",
    )
    fs.writeFileSync(path.join(privateRoot, "notes", "file.txt"), "attachment")
    built = prepareUnified(publicRoot, privateRoot, yaml)
    const read = (file) => fs.readFileSync(path.join(built.output, file), "utf8")
    assert.match(read("index.md"), /Public introduction/)
    assert.doesNotMatch(read("index.md"), /Members vault|private-tag/)
    assert.match(read("resources/notes/test.md"), /resources\/old-note/)
    assert.match(read("resources/notes/test.md"), /\[\[resources\/notes\/other\|Other\]\]/)
    assert.match(read("resources/notes/test.md"), /\/resources\/notes\/file.txt/)
    assert.ok(fs.existsSync(path.join(built.output, "calendar.md")))
    assert.ok(!fs.existsSync(path.join(built.output, "resources/.git")))
    fs.mkdirSync(path.join(publicRoot, "resources"))
    assert.throws(() => prepareUnified(publicRoot, privateRoot, yaml), /collides/)
  } finally {
    if (built) fs.rmSync(built.stage, { recursive: true, force: true })
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})
