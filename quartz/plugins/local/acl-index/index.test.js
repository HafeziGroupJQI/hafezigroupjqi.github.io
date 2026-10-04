import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { ContentIndex } from "@quartz-community/content-index"
import AclIndex, { aclPages, indexEntry, pageVaultPath } from "./index.js"

const page = (slug, frontmatter, extra = {}) => [
  { type: "root", children: [] },
  {
    data: {
      slug,
      relativePath: slug + ".md",
      frontmatter: { title: slug.split("/").pop(), tags: [], ...frontmatter },
      links: [],
      text: `the text of ${slug}`,
      ...extra,
    },
  },
]

const content = [
  page("index", { title: "Home" }),
  page(
    "resources/notes/open",
    {
      title: "Open",
      tags: ["planning"],
      edit_repo: "vault-private",
      edit_path: "notes/open.md",
    },
    { links: ["resources/projects/optical-rl/notes/meeting"], aliases: ["resources/old-open"] },
  ),
  page(
    "resources/projects/optical-rl/notes/meeting",
    {
      title: "Kerr meeting",
      acl: "r1",
      unlisted: true,
      edit_repo: "vault-private",
      edit_path: "projects/optical-rl/notes/meeting.qmd",
    },
    { unlisted: true, relativePath: "resources/projects/optical-rl/notes/Meeting.md" },
  ),
  page(
    "resources/projects/optical-rl/notes/plain",
    { acl: "r1", unlisted: true },
    { unlisted: true },
  ),
]

test("a restricted page's entry is the one Quartz's content index would make", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "acl-index-"))
  try {
    const plugin = ContentIndex({ enableSiteMap: false, enableRSS: false })
    await plugin.emit({ cfg: { configuration: {} }, argv: { output } }, content)
    const quartz = JSON.parse(
      fs.readFileSync(path.join(output, "static", "contentIndex.json"), "utf8"),
    )
    // Quartz leaves the unlisted pages out; its entries are what indexEntry makes.
    assert.deepEqual(Object.keys(quartz), ["index", "resources/notes/open"])
    for (const [, file] of content.slice(0, 2))
      assert.equal(JSON.stringify(indexEntry(file.data)), JSON.stringify(quartz[file.data.slug]))
  } finally {
    fs.rmSync(output, { recursive: true, force: true })
  }
})

test("the build records restricted entries by rule, private pages' files and their aliases", async () => {
  const pages = aclPages(content)
  assert.deepEqual(Object.keys(pages.entries), ["r1"])
  assert.deepEqual(Object.keys(pages.entries.r1), [
    "resources/projects/optical-rl/notes/meeting",
    "resources/projects/optical-rl/notes/plain",
  ])
  assert.equal(
    pages.entries.r1["resources/projects/optical-rl/notes/meeting"].title,
    "Kerr meeting",
  )
  assert.deepEqual(pages.pages, {
    "resources/notes/open": "notes/open.md",
    "resources/projects/optical-rl/notes/meeting": "projects/optical-rl/notes/meeting.qmd",
    "resources/projects/optical-rl/notes/plain": "projects/optical-rl/notes/plain.md",
  })
  assert.deepEqual(pages.aliases, {
    "resources/old-open": "notes/open.md",
    // alias-redirects' redirect from the file's own capitals.
    "resources/projects/optical-rl/notes/Meeting": "projects/optical-rl/notes/meeting.qmd",
  })
  assert.equal(
    pageVaultPath({ frontmatter: { title: "Generated" }, relativePath: "resources/index.md" }),
    null,
  )

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acl-index-"))
  const saved = process.env.SITE_ACL_PAGES
  try {
    process.env.SITE_ACL_PAGES = path.join(directory, "acl-pages.json")
    for await (const _ of AclIndex().emit({}, content));
    assert.deepEqual(JSON.parse(fs.readFileSync(process.env.SITE_ACL_PAGES, "utf8")), pages)
    delete process.env.SITE_ACL_PAGES
    fs.rmSync(path.join(directory, "acl-pages.json"))
    for await (const _ of AclIndex().emit({}, content));
    assert.equal(fs.readdirSync(directory).length, 0)
  } finally {
    if (saved === undefined) delete process.env.SITE_ACL_PAGES
    else process.env.SITE_ACL_PAGES = saved
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
