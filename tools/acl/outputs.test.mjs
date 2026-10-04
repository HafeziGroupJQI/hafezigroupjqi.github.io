import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { normalizeSnapshot } from "./policy.mjs"
import {
  linkForms,
  restrictedPaths,
  serializeIndex,
  splitIndex,
  writeContentIndex,
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
