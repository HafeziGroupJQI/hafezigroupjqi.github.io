import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import PageSource, { pageSource, sourcePath } from "./index.js"

test("a page's source loses only the build's own front matter keys", () => {
  const staged =
    "---\ntitle: Git\ntags:\n  - onboarding\nsite_public: true\nsite_internal: true\n---\n\nsite_public: true stays in the body.\n"
  assert.equal(
    pageSource(staged),
    "---\ntitle: Git\ntags:\n  - onboarding\n---\n\nsite_public: true stays in the body.\n",
  )
  assert.equal(pageSource("No front matter.\n"), "No front matter.\n")
  assert.equal(
    pageSource("---\r\ntitle: A\r\nsite_home: true\r\n---\r\nBody"),
    "---\r\ntitle: A\r\n---\r\nBody",
  )
})

test("only Markdown pages get a source, next to their HTML", () => {
  assert.equal(
    sourcePath("/out", { slug: "resources/onboarding/git", filePath: "c/onboarding/git.md" }),
    path.join("/out", "resources/onboarding/git.md"),
  )
  assert.equal(sourcePath("/out", { slug: "people/directory", filePath: "c/Directory.base" }), null)
  // Folder and tag pages are made by the build, from no file.
  assert.equal(sourcePath("/out", { slug: "tags/code" }), null)
  assert.equal(sourcePath("/out", undefined), null)
})

test("the emitter writes each published page's source into the output", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-source-"))
  try {
    const page = path.join(root, "git.md")
    fs.writeFileSync(page, "---\ntitle: Git\nsite_public: true\n---\n\n# Git\n")
    const output = path.join(root, "out")
    const content = [
      [{}, { data: { slug: "resources/onboarding/git", filePath: page } }],
      [{}, { data: { slug: "tags/onboarding" } }],
    ]
    const written = []
    for await (const file of PageSource().emit({ argv: { output } }, content)) written.push(file)
    assert.deepEqual(written, [path.join(output, "resources/onboarding/git.md")])
    assert.equal(fs.readFileSync(written[0], "utf8"), "---\ntitle: Git\n---\n\n# Git\n")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
