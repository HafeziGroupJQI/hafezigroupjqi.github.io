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
    fs.mkdirSync(path.join(publicRoot, "equipment"))
    fs.writeFileSync(
      path.join(publicRoot, "equipment", "laser.md"),
      "---\ntitle: Laser\ntype: equipment\nid: laser\n---\nPublic record",
    )
    fs.writeFileSync(
      path.join(publicRoot, "equipment", "index.md"),
      "---\ntitle: Lab Equipment\n---\nOverview",
    )
    fs.mkdirSync(path.join(privateRoot, "equipment"))
    fs.writeFileSync(
      path.join(privateRoot, "equipment", "laser-manual.md"),
      "---\ntitle: Laser manual\nequipment: [laser]\ntags: [internal, equipment]\n---\n![[files/laser.pdf]]\n[record](/equipment/laser)",
    )
    built = prepareUnified(publicRoot, privateRoot, yaml)
    const read = (file) => fs.readFileSync(path.join(built.output, file), "utf8")
    assert.match(read("index.md"), /Public introduction/)
    assert.doesNotMatch(read("index.md"), /Members vault|private-tag/)
    assert.match(read("resources/notes/test.md"), /resources\/old-note/)
    assert.match(read("resources/notes/test.md"), /\[\[resources\/notes\/other\|Other\]\]/)
    assert.match(read("resources/notes/test.md"), /\/resources\/notes\/file.txt/)
    assert.match(read("resources/index.md"), /resource-grid[\s\S]*\/resources\/notes\//)
    assert.match(read("resources/topics/index.md"), /href="\/tags\/private-tag"/)
    assert.match(read("resources/notes/index.md"), /tags:\n  - internal\n  - notes/)
    assert.match(
      read("equipment/laser.md"),
      /## Documents \(members\)[\s\S]*\[\[resources\/equipment\/laser-manual\|Laser manual\]\]/,
    )
    assert.match(read("equipment/index.md"), /resources\/equipment\/index/)
    assert.match(read("resources/equipment/laser-manual.md"), /\]\(\/equipment\/laser\)/)
    assert.match(read("resources/index.md"), /\/resources\/equipment\//)
    assert.ok(fs.existsSync(path.join(built.output, "calendar.md")))
    assert.ok(!fs.existsSync(path.join(built.output, "resources/.git")))
    fs.mkdirSync(path.join(publicRoot, "resources"))
    assert.throws(() => prepareUnified(publicRoot, privateRoot, yaml), /collides/)
  } finally {
    if (built) fs.rmSync(built.stage, { recursive: true, force: true })
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})
