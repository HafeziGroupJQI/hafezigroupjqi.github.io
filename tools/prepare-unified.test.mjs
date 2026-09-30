import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import yaml from "yaml"
import { blobSha } from "./docs-manifest.mjs"
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
    // Each private page knows its own file in the vault, for its Replace and Move tools, and for
    // its Edit and History tools with the blob it was built from.
    assert.match(read("resources/notes/test.md"), /vault_source: notes\/test.md/)
    const blob = (file) => blobSha(fs.readFileSync(file))
    assert.match(
      read("resources/notes/test.md"),
      new RegExp(
        `\nedit_repo: vault-private\nedit_path: notes/test.md\nedit_sha: ${blob(path.join(privateRoot, "notes", "test.md"))}\n`,
      ),
    )
    // So does every public page, by its path in the public vault; the home page, which the site
    // wraps in generated parts, says so.
    assert.match(
      read("equipment/laser.md"),
      new RegExp(
        `\nedit_repo: vault\nedit_path: content/equipment/laser.md\nedit_sha: ${blob(path.join(publicRoot, "equipment", "laser.md"))}\n`,
      ),
    )
    assert.match(
      read("index.md"),
      /\nedit_repo: vault\nedit_path: content\/index.md\nedit_sha: [0-9a-f]{40}\nedit_note: generated\n/,
    )
    // The stage keeps each public page's own file, which its Export gives as its Markdown.
    assert.equal(
      fs.readFileSync(path.join(built.stage, "sources/content/equipment/laser.md"), "utf8"),
      fs.readFileSync(path.join(publicRoot, "equipment", "laser.md"), "utf8"),
    )
    // Pages the site makes whole have no file to edit.
    for (const page of [
      "resources/index.md",
      "resources/notes/index.md",
      "recent.md",
      "uploads.md",
    ])
      assert.doesNotMatch(read(page), /edit_path/, page)
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
    // Recently modified is a member page: the live feed, over the build's list of the public
    // vault's changes (none in this fixture) until it loads.
    assert.match(
      read("recent.md"),
      /title: Recently modified[\s\S]*<div class="member-tools recent" data-recent><p>No changes to list yet/,
    )
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
    // A member's own settings page.
    assert.match(read("settings.md"), /data-settings/)
    // Uploads to the private vault.
    assert.match(read("uploads.md"), /data-uploads/)
    assert.match(read("uploads.md"), /layout: dashboard/)
    // The page editor.
    assert.match(read("edit.md"), /data-edit/)
    assert.match(read("edit.md"), /layout: dashboard/)
    assert.ok(!fs.existsSync(path.join(built.output, "resources/.git")))
    fs.mkdirSync(path.join(publicRoot, "resources"))
    assert.throws(() => prepareUnified(publicRoot, privateRoot, yaml), /collides/)
  } finally {
    if (built) fs.rmSync(built.stage, { recursive: true, force: true })
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

test("notebooks are listed by path; list_pages works in nested folders", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "unified-notebooks-"))
  const publicRoot = path.join(fixture, "public")
  const privateRoot = path.join(fixture, "private")
  let built
  let listed
  try {
    fs.mkdirSync(publicRoot)
    fs.writeFileSync(path.join(publicRoot, "index.md"), "---\ntitle: Hafezi Group\n---\nHome")
    fs.mkdirSync(path.join(privateRoot, "code", "wolfram-guide"), { recursive: true })
    fs.writeFileSync(
      path.join(privateRoot, "code", "wolfram-guide", "01-starting-out.nb"),
      "Notebook[{}]",
    )
    fs.writeFileSync(path.join(privateRoot, "code", "analysis.ipynb"), '{"cells": []}')
    // A Quarto document as render-qmd.mjs leaves it: the source and the page made from it.
    fs.writeFileSync(path.join(privateRoot, "code", "Sweep & fit.qmd"), "---\ntitle: Sweep\n---\n")
    fs.writeFileSync(
      path.join(privateRoot, "code", "Sweep & fit.md"),
      "---\ntitle: Sweep\nrendered_from: code/Sweep & fit.qmd\n---\n\nThe sweep.\n",
    )
    fs.writeFileSync(
      path.join(privateRoot, "code", "note.md"),
      "---\ntitle: Note\n---\nText [the analysis](analysis.ipynb), [[wolfram-guide/01-starting-out.nb|guide]]," +
        ' <a href="analysis.ipynb">here</a>, <img src="analysis.ipynb">',
    )
    built = prepareUnified(publicRoot, privateRoot, yaml)
    const read = (file) => fs.readFileSync(path.join(built.output, file), "utf8")
    // Links to a notebook go to its rendered page, not the raw file (a src stays the file).
    const note = read("resources/code/note.md")
    assert.match(note, /\[the analysis\]\(\/resources\/code\/analysis\.md\)/)
    assert.match(note, /\[\[resources\/code\/wolfram-guide\/01-starting-out\.md\|guide\]\]/)
    assert.match(note, /<a href="\/resources\/code\/analysis\.md">here<\/a>/)
    assert.match(note, /<img src="\/resources\/code\/analysis\.ipynb">/)
    // A Quarto page links its source like a notebook page; members download it from the document
    // store at its manifest key, so the source itself is not staged. data-source is its path in
    // the vault, for Open in Scratchpad.
    assert.match(
      read("resources/code/Sweep & fit.md"),
      /---\n\n<p class="wl-source" data-source="code\/Sweep &amp; fit\.qmd">Rendered from <a class="internal" href="\/resources\/code\/sweep--and--fit\.qmd">Sweep &amp; fit\.qmd<\/a><\/p>\n\nThe sweep\.\n$/,
    )
    assert.ok(!fs.existsSync(path.join(built.output, "resources/code/Sweep & fit.qmd")))
    // A Quarto page's own file is its source: its edits and history are the .qmd's.
    assert.match(read("resources/code/Sweep & fit.md"), /vault_source: code\/Sweep & fit.qmd/)
    assert.match(
      read("resources/code/Sweep & fit.md"),
      new RegExp(
        `\nedit_path: code/Sweep & fit.qmd\nedit_sha: ${blobSha(fs.readFileSync(path.join(privateRoot, "code", "Sweep & fit.qmd")))}\n`,
      ),
    )
    assert.doesNotMatch(note, /wl-source/)
    // The notebooks themselves are staged; their pages are made later in the build.
    assert.ok(
      fs.existsSync(path.join(built.output, "resources/code/wolfram-guide/01-starting-out.nb")),
    )
    // A generated section index lists every page under it, nested ones included.
    assert.match(read("resources/code/index.md"), /\[\[resources\/code\/analysis\|analysis\]\]/)
    assert.match(read("resources/code/index.md"), /\[\[resources\/code\/note\|note\]\]/)
    assert.match(
      read("resources/code/index.md"),
      /\[\[resources\/code\/wolfram-guide\/01-starting-out\|01-starting-out\]\]/,
    )
    // No top-level section is made for a course folder any more.
    assert.ok(!fs.existsSync(path.join(built.output, "resources/wolfram-guide")))
    // A hand-written index in a nested folder keeps its text; with list_pages it also lists the
    // pages of its own folder.
    fs.writeFileSync(
      path.join(privateRoot, "code", "wolfram-guide", "index.md"),
      "---\ntitle: Guide\ntags: [internal]\nlist_pages: true\n---\n\nAbout this guide.\n",
    )
    listed = prepareUnified(publicRoot, privateRoot, yaml)
    const guideIndex = fs.readFileSync(
      path.join(listed.output, "resources/code/wolfram-guide/index.md"),
      "utf8",
    )
    assert.match(
      guideIndex,
      /About this guide\.\n\n## Pages\n\n- \[\[resources\/code\/wolfram-guide\/01-starting-out\|01-starting-out\]\]\n$/,
    )
    // Its file is edited as written; the list is the site's.
    assert.match(
      guideIndex,
      /\nedit_path: code\/wolfram-guide\/index.md\n[\s\S]*edit_note: generated\n/,
    )
    // An index without list_pages is left as written.
    const plainIndex = path.join(listed.output, "resources/code/note.md")
    assert.doesNotMatch(fs.readFileSync(plainIndex, "utf8"), /## Pages/)
  } finally {
    for (const prepared of [built, listed])
      if (prepared) fs.rmSync(prepared.stage, { recursive: true, force: true })
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})
