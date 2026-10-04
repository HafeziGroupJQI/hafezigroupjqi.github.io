import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { decode, leakScan, needles, owners, report, sentences } from "./acl-leak-scan.mjs"
import { normalizeSnapshot } from "./acl/policy.mjs"

const acl = normalizeSnapshot({
  version: 4,
  groups: { "optical-rl": { logins: ["anishgoyal1108"], people: [] } },
  rules: [
    { id: "r1", pattern: "projects/optical-rl/", allow: ["group:optical-rl"] },
    { id: "r2", pattern: "notes/hr/", allow: ["login:hafezi"] },
  ],
})

const MEETING = "resources/projects/optical-rl/notes/meeting"
const SENTENCE_A =
  "The ring's policy maps four measured intensities onto two actions within one round trip"
const content = [
  "Kerr microring resonator as the policy of a reinforcement learning agent.",
  "The ring policy maps four measured intensities onto two actions within one round trip.",
  "Pasha proposed moving the optical and electronic boundary closer to the detector array.",
  "Short one.",
  "A sentence with a link to https://example.org that reads differently on the page itself.",
].join(" ")

// A members build in miniature: a restricted page with its own outputs, shard and refs, and the
// open pages around it.
function site(extra = {}) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "acl-leak-"))
  const files = {
    "static/acl-index/r1.json": JSON.stringify({
      [MEETING]: {
        slug: MEETING,
        filePath: `${MEETING}.md`,
        title: "Project Meeting --- A Kerr Microring as an RL Policy",
        links: ["resources/notes/open"],
        tags: [],
        content,
      },
    }),
    "static/acl-refs.json": JSON.stringify({
      version: 4,
      pages: {
        "resources/notes/open": "notes/open.md",
        [MEETING]: "projects/optical-rl/notes/meeting.qmd",
        "resources/projects/optical-rl/index": "projects/optical-rl/",
      },
      aliases: {
        "resources/projects/optical-rl/notes/Meeting": "projects/optical-rl/notes/meeting.qmd",
      },
      notebookAssets: { "ab/ab12cd34ef.png": ["projects/optical-rl/notes/run.nb"] },
      pdfs: { [`pdf/${MEETING}.pdf`]: "projects/optical-rl/notes/meeting.qmd" },
      files: {
        "resources/projects/optical-rl/assets/screen-annotated-pipeline.png":
          "projects/optical-rl/assets/screen-annotated-pipeline.png",
      },
    }),
    // The rule's own: its page and what is beside it, its folder page, alias, asset, image.
    [`${MEETING}.html`]: `<html><head><title>Project Meeting — A Kerr Microring as an RL Policy</title></head><body><a href="../../../../${MEETING}">x</a><p>${content}</p><img src="../assets/screen-annotated-pipeline.png"><img src="/notebook-assets/ab/ab12cd34ef.png"></body></html>`,
    [`${MEETING}.md`]: `---\ntitle: Project Meeting --- A Kerr Microring as an RL Policy\n---\n${content}`,
    [`${MEETING}.history.json`]: JSON.stringify({ path: "projects/optical-rl/notes/meeting.qmd" }),
    "resources/projects/optical-rl/index.html": `<a href="../../../${MEETING}">Project Meeting — A Kerr Microring as an RL Policy</a>`,
    "resources/projects/optical-rl/notes/Meeting.html": `<meta http-equiv="refresh" content="0; url=../../../../${MEETING}">`,
    "notebook-assets/ab/ab12cd34ef.png": "png",
    "resources/projects/optical-rl/assets/screen-annotated-pipeline.png": "png",
    // Open pages: one tags its list item and its transclusion with the rule.
    "resources/notes/open.html": `<html><body><p>Open notes.</p><ul data-acl="r1"><li><a href="../../${MEETING}">Project Meeting — A Kerr Microring as an RL Policy</a></li></ul><div data-acl="r1"><blockquote class="transclude"><p>${content}</p></blockquote></div></body></html>`,
    "resources/notes/open.md": "---\ntitle: Open\n---\nOpen notes.\n",
    "static/contentIndex.json": JSON.stringify({
      "resources/notes/open": {
        slug: "resources/notes/open",
        title: "Open",
        links: [],
        content: "Open notes.",
      },
    }),
    "index.html": "<html><body><p>Home</p></body></html>",
    // Binary files aren't searched.
    "static/og.webp": Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(MEETING)]),
    ...extra,
  }
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(output, file)), { recursive: true })
    fs.writeFileSync(path.join(output, file), text)
  }
  return output
}

const documents = {
  "resources/projects/optical-rl/files/analysis/lattice_memory_test.py": {
    sha: "a",
    size: 1,
    contentType: "text/x-python; charset=utf-8",
    repo: "vault-optical-rl",
  },
  "resources/files/readme-of-everything.txt": { sha: "b", size: 1, contentType: "text/plain" },
}

const scan = (extra) => {
  const output = site(extra)
  try {
    return leakScan(output, { acl, documents })
  } finally {
    fs.rmSync(output, { recursive: true, force: true })
  }
}

test("distinctive sentences read the same on every output", () => {
  assert.deepEqual(sentences(content), [
    "Pasha proposed moving the optical and electronic boundary closer to the detector array.",
    "The ring policy maps four measured intensities onto two actions within one round trip.",
    "Kerr microring resonator as the policy of a reinforcement learning agent.",
  ])
  assert.deepEqual(sentences(`${SENTENCE_A}. ${"x".repeat(30)}.`), [])
  assert.equal(decode("a &amp; b &#039;c&#x27; &lt;"), "a & b 'c' <")
})

test("a restricted page's needles: slug, title, its rule's file names, sentences", () => {
  const output = site()
  try {
    const refs = JSON.parse(fs.readFileSync(path.join(output, "static/acl-refs.json"), "utf8"))
    const shards = {
      r1: JSON.parse(fs.readFileSync(path.join(output, "static/acl-index/r1.json"))),
    }
    const list = needles({ refs, acl, shards, documents })
    const kinds = (kind) => list.filter((n) => n.kind === kind).map((n) => n.needle)
    assert.deepEqual(kinds("slug"), [MEETING])
    assert.ok(kinds("title").includes("Project Meeting — A Kerr Microring as an RL Policy"))
    assert.deepEqual(kinds("file").sort(), [
      "ab12cd34ef.png",
      "lattice_memory_test.py",
      "screen-annotated-pipeline.png",
    ])
    assert.equal(kinds("sentence").length, 3)
    assert.ok(list.every((needle) => needle.rule === "r1"))
    const own = owners(refs, acl, ["r1"])
    for (const file of [
      `${MEETING}.html`,
      `${MEETING}.md`,
      `${MEETING}-og-image.webp`,
      "resources/projects/optical-rl/index.html",
      "resources/projects/optical-rl/notes/Meeting.html",
      `pdf/${MEETING}.pdf`,
      "notebook-assets/ab/ab12cd34ef.png",
      "static/acl-index/r1.json",
    ])
      assert.deepEqual([...own.get(file)], ["r1"], file)
    assert.equal(own.has("resources/notes/open.html"), false)
  } finally {
    fs.rmSync(output, { recursive: true, force: true })
  }
})

test("a clean build passes: the rule's own files and its data-acl elements hold its words", () => {
  const result = scan()
  assert.deepEqual(result.hits, [])
  assert.ok(result.files >= 10)
  assert.ok(result.needles >= 8)
})

test("each kind of needle outside the rule's files and elements fails, with its file", () => {
  const result = scan({
    // A link to the restricted page in an open page.
    "resources/notes/linked.html": `<p><a href="../../${MEETING}" class="internal">see</a></p>`,
    // Its title in a JSON file, its sentence in a page's text.
    "static/extra.json": JSON.stringify({
      x: { title: "Project Meeting --- A Kerr Microring as an RL Policy" },
    }),
    "resources/notes/quoted.html": `<p>The ring policy maps four measured intensities onto two
      actions within one round trip.</p>`,
    // Its image's and its document's names, in an open page and a script.
    "resources/notes/pictured.html": `<img src="/x/screen-annotated-pipeline.png">`,
    "static/app.js": `fetch("/resources/files/lattice_memory_test.py")`,
    // Under another rule's data-acl isn't under its own.
    "resources/notes/hr/other.html": `<div data-acl="r2"><p>Pasha proposed moving the optical and electronic boundary closer to the detector array.</p></div>`,
    // A Markdown source with the slug outside a data-acl block.
    "resources/notes/source.md": `<div data-acl="r1">\n\n![[${MEETING}]]\n\n</div>\n\n[[${MEETING}]]\n`,
  })
  const found = result.hits.map((hit) => [hit.file, hit.kind]).sort()
  assert.deepEqual(found, [
    ["resources/notes/hr/other.html", "sentence"],
    ["resources/notes/linked.html", "slug"],
    ["resources/notes/pictured.html", "file"],
    ["resources/notes/quoted.html", "sentence"],
    ["resources/notes/source.md", "slug"],
    ["static/app.js", "file"],
    ["static/extra.json", "title"],
  ])
  assert.ok(result.hits.every((hit) => hit.rule === "r1"))
  assert.match(report(result.hits), /resources\/notes\/linked\.html: r1 slug "resources\/projects/)
})

test("a slug or file name inside a longer one isn't a needle's", () => {
  const result = scan({
    "resources/notes/near.html": `<a href="/${MEETING}-notes">x</a><img src="/old-screen-annotated-pipeline.png">`,
  })
  assert.deepEqual(result.hits, [])
})
