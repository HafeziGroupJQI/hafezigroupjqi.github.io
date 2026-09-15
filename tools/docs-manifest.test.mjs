import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  docsManifest,
  documentExtensions,
  pruneDocuments,
  untrackedDocuments,
  writeDocsManifest,
} from "./docs-manifest.mjs"

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

const repository = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hafezi-docs-"))
  git(root, "init", "-q")
  git(root, "config", "user.email", "test@example.com")
  git(root, "config", "user.name", "test")
  const write = (file, content = "x") => {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  write("files/equipment/Big Laser/Manual (Rev 2).PDF", "%PDF-1.4 laser")
  write("files/equipment/scope/scope.pdf", "%PDF-1.4 scope")
  write("notes/meeting.md", "---\ntitle: Meeting\n---\n")
  write("assets/photo.png", "png")
  write("files/scripts/run.py", "print(1)\n")
  write("node_modules/dep/index.js", "module.exports = 1")
  write(".obsidian/app.json", "{}")
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "seed")
  return root
}

test("manifest keys documents by their slugified site path with git blob shas", () => {
  const root = repository()
  try {
    const manifest = docsManifest(root, { excluded: new Set(["node_modules"]) })
    assert.deepEqual(Object.keys(manifest), [
      "resources/files/equipment/big-laser/manual-(rev-2).PDF",
      "resources/files/equipment/scope/index.pdf",
      "resources/files/scripts/run.py",
    ])
    const laser = manifest["resources/files/equipment/big-laser/manual-(rev-2).PDF"]
    assert.equal(
      laser.sha,
      git(root, "hash-object", "files/equipment/Big Laser/Manual (Rev 2).PDF").trim(),
    )
    assert.equal(laser.size, "%PDF-1.4 laser".length)
    assert.equal(laser.contentType, "application/pdf")
    assert.equal(manifest["resources/files/scripts/run.py"].contentType, "text/x-python; charset=utf-8")
    assert.deepEqual(documentExtensions(manifest).sort(), [".PDF", ".pdf", ".py"])
    const file = path.join(root, "out", "manifest.json")
    writeDocsManifest(manifest, file)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).documents, manifest)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("uncommitted documents are reported and stray manifest files are pruned", () => {
  const root = repository()
  try {
    const manifest = docsManifest(root)
    const stage = path.join(root, "stage")
    fs.cpSync(path.join(root, "files"), path.join(stage, "resources", "files"), { recursive: true })
    fs.writeFileSync(path.join(stage, "resources", "files", "new.pdf"), "%PDF new")
    assert.deepEqual(untrackedDocuments(stage, manifest), ["resources/files/new.pdf"])
    fs.rmSync(path.join(stage, "resources", "files", "new.pdf"))
    assert.deepEqual(untrackedDocuments(stage, manifest), [])

    const output = path.join(root, "output")
    fs.mkdirSync(path.join(output, "resources", "files", "scripts"), { recursive: true })
    fs.writeFileSync(path.join(output, "resources", "files", "scripts", "run.py"), "print(1)\n")
    fs.writeFileSync(path.join(output, "resources", "files", "scripts", "index.html"), "<p>")
    fs.writeFileSync(path.join(output, "resources", "files", "scripts", "figure.png"), "png")
    assert.equal(pruneDocuments(output, manifest), 1)
    assert.ok(!fs.existsSync(path.join(output, "resources", "files", "scripts", "run.py")))
    assert.ok(fs.existsSync(path.join(output, "resources", "files", "scripts", "index.html")))
    fs.writeFileSync(path.join(output, "resources", "files", "scripts", "stray.txt"), "x")
    assert.throws(() => pruneDocuments(output, manifest), /commit it first/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
