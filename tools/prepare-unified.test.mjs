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
      "---\ntitle: Laser manual\nequipment: [laser]\ntags: [internal, equipment, equipment/laser]\n---\n![[files/laser.pdf]]\n[record](/equipment/laser)",
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
    // Tags that name a note get a tag page linking to it (so the note shows a backlink).
    assert.match(read("tags/equipment/laser.md"), /\[\[equipment\/laser\|Laser\]\]/)
    assert.ok(!fs.existsSync(path.join(built.output, "tags/private-tag.md")))
    assert.match(read("resources/index.md"), /\/resources\/equipment\//)
    assert.ok(fs.existsSync(path.join(built.output, "calendar.md")))
    // The devices dashboard renders full-bleed; the legacy pages still exist and redirect to it.
    assert.match(read("devices.md"), /layout: dashboard/)
    assert.match(read("devices.md"), /data-dashboard/)
    assert.match(read("gpt.md"), /data-hafezi-gpt/)
    assert.match(read("gpt.md"), /layout: dashboard/)
    assert.match(read("admin.md"), /data-admin/)
    assert.match(read("device.md"), /data-device/)
    assert.match(read("instrument.md"), /data-instrument/)
    assert.match(read("experiment-builder.md"), /data-experiment-builder/)
    assert.match(read("experiments.md"), /data-experiments/)
    assert.match(read("device.md"), /Redirecting to the devices dashboard/)
    // The Scratchpad is another full-bleed member tool.
    assert.match(read("scratchpad.md"), /layout: dashboard/)
    assert.match(read("scratchpad.md"), /data-scratchpad/)
    assert.ok(!fs.existsSync(path.join(built.output, "resources/.git")))
    fs.mkdirSync(path.join(publicRoot, "resources"))
    assert.throws(() => prepareUnified(publicRoot, privateRoot, yaml), /collides/)
  } finally {
    if (built) fs.rmSync(built.stage, { recursive: true, force: true })
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

test("notebooks are listed in their section by path; a wolfram-guide folder is a section", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "unified-notebooks-"))
  const publicRoot = path.join(fixture, "public")
  const privateRoot = path.join(fixture, "private")
  let built
  let plain
  try {
    fs.mkdirSync(publicRoot)
    fs.writeFileSync(path.join(publicRoot, "index.md"), "---\ntitle: Hafezi Group\n---\nHome")
    fs.mkdirSync(path.join(privateRoot, "wolfram-guide"), { recursive: true })
    fs.mkdirSync(path.join(privateRoot, "code"), { recursive: true })
    fs.writeFileSync(path.join(privateRoot, "wolfram-guide", "01-starting-out.nb"), "Notebook[{}]")
    fs.writeFileSync(path.join(privateRoot, "code", "analysis.ipynb"), '{"cells": []}')
    fs.writeFileSync(path.join(privateRoot, "code", "note.md"), "---\ntitle: Note\n---\nText")
    built = prepareUnified(publicRoot, privateRoot, yaml)
    const read = (file) => fs.readFileSync(path.join(built.output, file), "utf8")
    // The notebooks themselves are staged; their pages are made later in the build.
    assert.ok(fs.existsSync(path.join(built.output, "resources/wolfram-guide/01-starting-out.nb")))
    assert.match(read("resources/wolfram-guide/index.md"), /title: Wolfram Language guide/)
    assert.match(
      read("resources/wolfram-guide/index.md"),
      /\[\[resources\/wolfram-guide\/01-starting-out\|01-starting-out\]\]/,
    )
    assert.match(read("resources/code/index.md"), /\[\[resources\/code\/analysis\|analysis\]\]/)
    assert.match(read("resources/code/index.md"), /\[\[resources\/code\/note\|note\]\]/)
    // A hand-written section index keeps its text; with list_pages it also lists the pages.
    fs.writeFileSync(
      path.join(privateRoot, "wolfram-guide", "index.md"),
      "---\ntitle: Guide\ntags: [internal]\nlist_pages: true\n---\n\nAbout this guide.\n",
    )
    const listed = prepareUnified(publicRoot, privateRoot, yaml)
    const guideIndex = fs.readFileSync(
      path.join(listed.output, "resources/wolfram-guide/index.md"),
      "utf8",
    )
    fs.rmSync(listed.stage, { recursive: true, force: true })
    assert.match(
      guideIndex,
      /About this guide\.\n\n## Pages\n\n- \[\[resources\/wolfram-guide\/01-starting-out\|01-starting-out\]\]\n$/,
    )
    // Without the folder there is no section.
    fs.rmSync(path.join(privateRoot, "wolfram-guide"), { recursive: true })
    plain = prepareUnified(publicRoot, privateRoot, yaml)
    assert.ok(!fs.existsSync(path.join(plain.output, "resources/wolfram-guide")))
  } finally {
    for (const prepared of [built, plain])
      if (prepared) fs.rmSync(prepared.stage, { recursive: true, force: true })
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})
