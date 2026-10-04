import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { normalizeSnapshot } from "./policy.mjs"
import {
  aclRefs,
  linkForms,
  restrictedPaths,
  serializeIndex,
  splitIndex,
  writeContentIndex,
  writeRefs,
} from "./outputs.mjs"

const acl = normalizeSnapshot({
  version: 2,
  rules: [
    { id: "r1", pattern: "projects/optical-rl/", allow: ["group:optical-rl"] },
    { id: "r2", pattern: "notes/secret.md", allow: ["login:ada"] },
  ],
})

test("an index serializes as JSON.stringify would, with each entry's place in the text", () => {
  const entries = [
    ["résumé/ü", { slug: "résumé/ü", title: "Ünïcode 𝄞 “quotes”", links: [], content: "a\nb" }],
    ["b", { slug: "b", links: ["résumé/ü"] }],
  ]
  const { text, offsets } = serializeIndex(entries)
  assert.equal(text, JSON.stringify(Object.fromEntries(entries)))
  for (const [slug, value] of entries) {
    const [start, end] = offsets[slug]
    assert.equal(text.slice(start, end), `${JSON.stringify(slug)}:${JSON.stringify(value)}`)
  }
  assert.deepEqual(serializeIndex([]), { text: "{}", offsets: {} })
})

test("links to restricted pages, folders and documents leave other rules' entries", () => {
  assert.deepEqual(linkForms("resources/x/index"), ["resources/x/index", "resources/x/"])
  const restricted = restrictedPaths({
    entries: {
      r1: { "resources/projects/optical-rl/notes/meeting": {} },
      r2: { "resources/notes/secret": {} },
    },
    folders: {
      "resources/projects": { path: "projects" },
      "resources/projects/optical-rl": { path: "projects/optical-rl", acl: "r1" },
    },
    documents: {
      "resources/projects/optical-rl/files/run.py": { sha: "a" },
      "resources/files/open.pdf": { sha: "b" },
    },
    acl,
  })
  assert.deepEqual(Object.fromEntries(restricted), {
    "resources/projects/optical-rl/notes/meeting": "r1",
    "resources/notes/secret": "r2",
    "resources/projects/optical-rl/index": "r1",
    "resources/projects/optical-rl/": "r1",
    "resources/projects/optical-rl/files/run.py": "r1",
  })
  const links = [
    "resources/projects/optical-rl/notes/meeting",
    "resources/projects/optical-rl/",
    "resources/projects/optical-rl/files/run.py",
    "resources/notes/secret",
    "resources/files/open.pdf",
  ]
  const { base, shards } = splitIndex(
    [
      ["resources/notes/open", { slug: "resources/notes/open", title: "Open", links }],
      // Indexed by Quartz although restricted: moved to its rule's shard.
      ["resources/notes/secret", { slug: "resources/notes/secret", title: "Secret", links }],
    ],
    {
      r1: {
        "resources/projects/optical-rl/notes/meeting": {
          slug: "resources/projects/optical-rl/notes/meeting",
          links,
        },
      },
    },
    restricted,
  )
  assert.deepEqual(base, [
    [
      "resources/notes/open",
      { slug: "resources/notes/open", title: "Open", links: ["resources/files/open.pdf"] },
    ],
  ])
  assert.deepEqual(shards.r2[0][1].links, ["resources/notes/secret", "resources/files/open.pdf"])
  assert.deepEqual(shards.r1[0][1].links, [
    "resources/projects/optical-rl/notes/meeting",
    "resources/projects/optical-rl/",
    "resources/projects/optical-rl/files/run.py",
    "resources/files/open.pdf",
  ])
})

test("the build rewrites the index, its offsets and each rule's shard", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "acl-outputs-"))
  try {
    fs.mkdirSync(path.join(output, "static"))
    const quartz = {
      "resources/notes/open": {
        slug: "resources/notes/open",
        filePath: "resources/notes/open.md",
        title: "Open",
        links: ["resources/projects/optical-rl/notes/meeting"],
        tags: [],
        content: "open",
      },
    }
    fs.writeFileSync(path.join(output, "static", "contentIndex.json"), JSON.stringify(quartz))
    const meeting = {
      slug: "resources/projects/optical-rl/notes/meeting",
      filePath: "resources/projects/optical-rl/notes/meeting.md",
      title: "Kerr meeting",
      links: ["resources/notes/open"],
      tags: [],
      content: "secret",
    }
    const counts = writeContentIndex(output, {
      pages: { entries: { r1: { [meeting.slug]: meeting } } },
      folders: {},
      documents: {},
      acl,
    })
    assert.deepEqual(counts, { base: 1, restricted: { r1: 1 } })
    const read = (file) => fs.readFileSync(path.join(output, "static", file), "utf8")
    const index = read("contentIndex.json")
    assert.deepEqual(JSON.parse(index)["resources/notes/open"].links, [])
    const [start, end] = JSON.parse(read("contentIndex.offsets.json"))["resources/notes/open"]
    assert.match(index.slice(start, end), /^"resources\/notes\/open":\{.*\}$/)
    assert.deepEqual(JSON.parse(read("acl-index/r1.json")), { [meeting.slug]: meeting })
    assert.throws(
      () =>
        writeContentIndex(output, {
          pages: { entries: { "../x": { [meeting.slug]: meeting } } },
          folders: {},
          documents: {},
          acl,
        }),
      /can't name a file/,
    )
  } finally {
    fs.rmSync(output, { recursive: true, force: true })
  }
})

test("the refs name every private page's, alias's, asset's, pdf's and restricted file's vault path", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "acl-refs-"))
  const touch = (file) => {
    fs.mkdirSync(path.dirname(path.join(output, file)), { recursive: true })
    fs.writeFileSync(path.join(output, file), "x")
  }
  try {
    for (const file of [
      "resources/notes/open.html",
      "resources/old-open.html",
      "resources/projects/optical-rl/notes/meeting.html",
      "resources/projects/optical-rl/notes/meeting-og-image.webp",
      "resources/projects/optical-rl/index.html",
      "resources/projects/optical-rl/assets/plot-2.png",
      "resources/projects/optical-rl/notes/run_files/figure-gfm/cell-1.png",
      "resources/assets/open.png",
      "pdf/resources/projects/optical-rl/notes/meeting.pdf",
      "pdf/people/ada.pdf",
    ])
      touch(file)
    const refs = aclRefs(output, {
      acl,
      pages: {
        pages: {
          "resources/notes/open": "notes/open.md",
          "resources/projects/optical-rl/notes/meeting": "projects/optical-rl/notes/meeting.qmd",
          "resources/projects/optical-rl/notes/run": "projects/optical-rl/notes/run.ipynb",
        },
        aliases: { "resources/old-open": "notes/open.md", "resources/gone": "notes/open.md" },
      },
      folders: {
        "resources/projects/optical-rl": { path: "projects/optical-rl", acl: "r1" },
        "resources/notes": { path: "notes" },
      },
      notebooks: {
        wolfram: {
          pages: [
            {
              source: "resources/projects/optical-rl/nb/a.nb",
              assets: ["aa/aa1.png", "ss/sym.json"],
            },
            { source: "resources/notes/b.nb", assets: ["aa/aa1.png", "bb/bb1.png", "ss/sym.json"] },
            { source: "public/c.nb", assets: ["ss/sym.json"] },
          ],
        },
      },
      vaultFiles: [{ path: "projects/optical-rl/assets/plot 2.png" }, { path: "assets/open.png" }],
    })
    assert.deepEqual(refs, {
      version: 2,
      pages: {
        "resources/notes/open": "notes/open.md",
        "resources/projects/optical-rl/notes/meeting": "projects/optical-rl/notes/meeting.qmd",
        "resources/projects/optical-rl/notes/run": "projects/optical-rl/notes/run.ipynb",
        "resources/projects/optical-rl/index": "projects/optical-rl/",
      },
      aliases: { "resources/old-open": "notes/open.md" },
      notebookAssets: {
        "aa/aa1.png": ["notes/b.nb", "projects/optical-rl/nb/a.nb"],
        "bb/bb1.png": ["notes/b.nb"],
      },
      pdfs: {
        "pdf/resources/projects/optical-rl/notes/meeting.pdf":
          "projects/optical-rl/notes/meeting.qmd",
      },
      files: {
        "resources/projects/optical-rl/assets/plot-2.png": "projects/optical-rl/assets/plot 2.png",
        "resources/projects/optical-rl/notes/run_files/figure-gfm/cell-1.png":
          "projects/optical-rl/notes/run.ipynb",
      },
    })
    writeRefs(output, refs)
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(output, "static", "acl-refs.json"), "utf8")),
      refs,
    )
  } finally {
    fs.rmSync(output, { recursive: true, force: true })
  }
})
