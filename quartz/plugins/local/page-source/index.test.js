import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import PageSource, { pageSource, sourcePath, vaultFile } from "./index.js"

test("a page's source loses only the build's own front matter keys", () => {
  const staged =
    "---\ntitle: Git\ntags:\n  - onboarding\nsite_public: true\nsite_internal: true\n---\n\nsite_public: true stays in the body.\n"
  assert.equal(
    pageSource(staged),
    "---\ntitle: Git\ntags:\n  - onboarding\n---\n\nsite_public: true stays in the body.\n",
  )
  assert.equal(pageSource("No front matter.\n"), "No front matter.\n")
  // The page's own file in the vault is the build's too, even folded onto more lines.
  assert.equal(
    pageSource(
      "---\ntitle: Sweep\nvault_source: code/a folder with a long name/and a long file name that goes on\n  and on.qmd\nedit_repo: vault-private\nedit_path: code/a folder with a long name/and a long file name that goes on\n  and on.qmd\nedit_sha: 0123456789abcdef0123456789abcdef01234567\nedit_mode: notebook\nedit_note: generated\ntags:\n  - code\n---\n\nedit_path: stays in the body.\n",
    ),
    "---\ntitle: Sweep\ntags:\n  - code\n---\n\nedit_path: stays in the body.\n",
  )
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

test("a public page's source is its file as the vault has it, a private page's the staged copy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-source-"))
  try {
    const content = path.join(root, "content")
    const own = "---\ntitle: Ada\nplaces: [atlantic-2369]\n---\n\nAda's page.\n"
    const staged =
      '---\ntitle: Ada\nplaces:\n  - atlantic-2369\nsite_public: true\nedit_repo: vault\nedit_path: content/people/ada.md\n---\n\n<section class="profile-contact"></section>\n\nAda\'s page.\n'
    fs.mkdirSync(path.join(content, "people"), { recursive: true })
    fs.mkdirSync(path.join(root, "sources", "content", "people"), { recursive: true })
    fs.writeFileSync(path.join(content, "people", "ada.md"), staged)
    fs.writeFileSync(path.join(root, "sources", "content", "people", "ada.md"), own)
    fs.mkdirSync(path.join(content, "resources"))
    fs.writeFileSync(
      path.join(content, "resources", "git.md"),
      "---\ntitle: Git\nedit_repo: vault-private\nedit_path: onboarding/git.md\n---\n\n[[resources/x]]\n",
    )
    const output = path.join(root, "out")
    const data = (slug, file, frontmatter) => ({
      data: { slug, filePath: path.join(content, file), frontmatter },
    })
    const pages = [
      [
        {},
        data("people/ada", "people/ada.md", {
          edit_repo: "vault",
          edit_path: "content/people/ada.md",
        }),
      ],
      [
        {},
        data("resources/git", "resources/git.md", {
          edit_repo: "vault-private",
          edit_path: "onboarding/git.md",
        }),
      ],
    ]
    for await (const _ of PageSource().emit({ argv: { output, directory: content } }, pages));
    assert.equal(fs.readFileSync(path.join(output, "people/ada.md"), "utf8"), own)
    assert.equal(
      fs.readFileSync(path.join(output, "resources/git.md"), "utf8"),
      "---\ntitle: Git\n---\n\n[[resources/x]]\n",
    )
    // Only a file under the stage's sources/ is ever read.
    assert.equal(
      vaultFile(content, {
        frontmatter: { edit_repo: "vault", edit_path: "content/../../etc/passwd.md" },
      }),
      null,
    )
    assert.equal(
      vaultFile(content, {
        frontmatter: { edit_repo: "vault", edit_path: "content/people/none.md" },
      }),
      null,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
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
