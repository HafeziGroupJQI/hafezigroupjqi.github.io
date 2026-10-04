import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import yaml from "yaml"
import { prepareUnified } from "../prepare-unified.mjs"
import { aclList, wrapEmbeds } from "./lists.mjs"
import { normalizeSnapshot } from "./policy.mjs"

test("a list keeps its open items in Markdown and puts other rules' under data-acl", () => {
  const items = [
    { href: "/a", title: "Open", acl: null },
    { href: "/b", title: "Kerr <ring>", acl: "r1" },
    { href: "/c", title: "Mine", acl: "r2" },
  ]
  const list = aclList(items, "r2", (item) => `- [[${item.href}|${item.title}]]`)
  assert.equal(
    list,
    '- [[/a|Open]]\n- [[/c|Mine]]\n\n<ul data-acl="r1">\n<li><a class="internal" href="/b">Kerr &lt;ring&gt;</a></li>\n</ul>',
  )
  assert.equal(aclList([], null, String), "")
})

test("embeds of other rules' pages and files are wrapped, a block's in a div", () => {
  const aclOf = (target) => (target.includes("optical-rl") ? "r1" : null)
  const text = [
    "Intro with ![plot](/resources/projects/optical-rl/assets/plot.png) inline.",
    "![[resources/projects/optical-rl/notes/meeting]]",
    "![[resources/notes/open]]",
    "```",
    "![[resources/projects/optical-rl/notes/meeting]]",
    "```",
  ].join("\n")
  assert.equal(
    wrapEmbeds(text, null, aclOf),
    [
      'Intro with <span data-acl="r1">![plot](/resources/projects/optical-rl/assets/plot.png)</span> inline.',
      '<div data-acl="r1">',
      "",
      "![[resources/projects/optical-rl/notes/meeting]]",
      "",
      "</div>",
      "![[resources/notes/open]]",
      "```",
      "![[resources/projects/optical-rl/notes/meeting]]",
      "```",
    ].join("\n"),
  )
  // In a page of the same rule, nothing changes.
  assert.equal(wrapEmbeds(text, "r1", aclOf), text)
})

test("prepare-unified tags or leaves out restricted pages in what it lists", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "hafezi-acl-lists-"))
  const publicRoot = path.join(fixture, "public")
  const privateRoot = path.join(fixture, "private")
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true })
    fs.writeFileSync(path.join(fixture, file), text)
  }
  write("public/index.md", "---\ntitle: Home\n---\nHome")
  write("public/equipment/laser.md", "---\ntitle: Laser\ntype: equipment\nid: laser\n---\nLaser")
  write(
    "private/projects/index.md",
    "---\ntitle: Projects\nlist_pages: true\n---\nEvery project.\n\n![[projects/optical-rl/notes/meeting]]\n",
  )
  write(
    "private/projects/topo.md",
    "---\ntitle: Topo\nequipment: laser\ntags: [project/topo]\n---\n",
  )
  write(
    "private/projects/optical-rl/notes/meeting.md",
    "---\ntitle: Kerr meeting\nequipment: laser\ntags: [project/optical-rl]\n---\nSecret\n\n![[projects/topo]]\n",
  )
  write("private/projects/optical-rl/notes/run.ipynb", "{}")
  const acl = normalizeSnapshot({
    version: 1,
    rules: [{ id: "r1", pattern: "projects/optical-rl/", allow: ["group:optical-rl"] }],
  })
  let built
  try {
    built = prepareUnified(publicRoot, privateRoot, yaml, { acl })
    const read = (file) => fs.readFileSync(path.join(built.output, file), "utf8")
    const laser = read("equipment/laser.md")
    assert.match(laser, /## Documents \(members\)\n\n- \[\[resources\/projects\/topo\|Topo\]\]/)
    assert.match(
      laser,
      /<ul data-acl="r1">\n<li><a class="internal" href="\/resources\/projects\/optical-rl\/notes\/meeting">Kerr meeting<\/a><\/li>/,
    )
    const index = read("resources/projects/index.md")
    assert.match(index, /- \[\[resources\/projects\/topo\|topo\]\]/)
    assert.match(
      index,
      /<ul data-acl="r1">\n<li><a class="internal" href="\/resources\/projects\/optical-rl\/notes\/meeting">meeting<\/a><\/li>\n<li><a class="internal" href="\/resources\/projects\/optical-rl\/notes\/run">run<\/a><\/li>\n<\/ul>/,
    )
    // The transclusion of a restricted page in an open one is under its rule; the other way isn't.
    assert.match(
      index,
      /<div data-acl="r1">\n\n!\[\[resources\/projects\/optical-rl\/notes\/meeting\]\]\n\n<\/div>/,
    )
    assert.match(
      read("resources/projects/optical-rl/notes/meeting.md"),
      /\n!\[\[resources\/projects\/topo\]\]\n/,
    )
    // Topics and tag pages are every member's: a restricted page's tags aren't there.
    const topics = read("resources/topics/index.md")
    assert.match(topics, /project\/topo/)
    assert.doesNotMatch(topics, /optical-rl/)
    assert.ok(!fs.existsSync(path.join(built.output, "tags", "project", "optical-rl.md")))
  } finally {
    if (built) fs.rmSync(built.stage, { recursive: true, force: true })
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})
