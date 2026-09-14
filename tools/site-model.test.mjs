import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cards, peoplePage, relativeUrl, rewriteLinks, publicationList, profileContact } from "./site-model.mjs"
import { prepareSite } from "./prepare-site.mjs"

const person = (title, group, photo) => ({
  slug: "people/" + title.toLowerCase(),
  fm: { title, type: "person", group, photo, role: "Graduate Student" }, body: "",
})

test("every person, including alumni and an unfamiliar group, is visible without switching tabs", () => {
  const html = peoplePage([person("Zoe", "Graduate Students", "assets/zoe.jpg"), person("Amy", "Graduate Students"), person("Jo", "Alumni"), person("Lee", "Visiting researchers")])
  assert.equal((html.match(/class="person-card"/g) ?? []).length, 4)
  assert.ok(html.indexOf("people/amy") < html.indexOf("people/zoe"))
  assert.match(html, /id="alumni"/)
  assert.match(html, /src="\.\.\/assets\/zoe.jpg"/)
  assert.match(html, /href="\.\.\/people\/directory\/"/)
  assert.doesNotMatch(html, /hidden|display:none/)
})

test("nested pages and subpath hosting resolve to the same local records", () => {
  assert.equal(relativeUrl("people/index", "people/amy"), "../people/amy")
  assert.equal(relativeUrl("people/directory/index", "assets/amy.jpg"), "../../assets/amy.jpg")
  assert.equal(new URL(relativeUrl("people/index", "people/amy"), "https://example.org/group/people/").pathname, "/group/people/amy")
})

test("card text and attributes are escaped, and missing photos are explicit", () => {
  const html = cards([person('<Amy & "Jo">', "Members")], "people/index", { people: true })
  assert.match(html, /&lt;Amy &amp; &quot;Jo&quot;&gt;/)
  assert.match(html, /Photo unavailable/)
  assert.doesNotMatch(html, /<Amy/)
})

test("legacy directory links preserve labels and unrelated resources", () => {
  assert.equal(rewriteLinks("[[people/Directory.base|directory]] [[people/index|Directory]] [[people/amy|Amy]]"), "[[people/directory/index|directory]] [[people/directory/index|Contact directory]] [[people/amy|Amy]]")
  assert.equal(rewriteLinks("[[welcome#start|Start]]"), "[[onboarding/welcome#start|Start]]")
})

test("publication listings preserve authors, venue and year without undefined values", () => {
  const html = publicationList([{ slug: "publications/paper", fm: { title: "Paper", authors: ["A", "B"], venue: "PRL", year: 2026 } }], "index")
  assert.match(html, /A, B · PRL · 2026/)
  assert.doesNotMatch(html, /undefined|null/)
})

test("profiles expose confirmed contact fields without presenting TBD as contact data", () => {
  const html = profileContact({ email: "amy@umd.edu", building: "Atlantic", office: "TBD" })
  assert.match(html, /mailto:amy@umd.edu/)
  assert.match(html, /Atlantic/)
  assert.doesNotMatch(html, /TBD|Office/)
})

test("preparation preserves vault files, relocates welcome, and keeps a legacy directory alias", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "hafezi-fixture-"))
  // JSON is a YAML subset; inject its codec so this orchestration test needs no packages.
  const codec = { parse: JSON.parse, stringify: (value) => JSON.stringify(value) + "\n" }
  const put = (slug, fm, body) => {
    const filename = path.join(source, slug + ".md")
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, `---\n${codec.stringify(fm)}---\n\n${body}\n`)
  }
  put("index", { title: "Welcome" }, "Welcome to the group")
  put("about", { title: "About", source: "https://hafezi.jqi.umd.edu/" }, "![[assets/hero.png]]\n\nReal about text")
  put("onboarding/index", { title: "Onboarding" }, "Checklists")
  put("people/index", { title: "Directory" }, "Directory instructions")
  put("people/amy", person("Amy", "Graduate Students", "assets/amy.jpg").fm, "![[assets/amy.jpg]]\n\nAmy's biography")
  put("materials/index", { title: "Materials" }, "Material data stays here")
  fs.writeFileSync(path.join(source, "people/Directory.base"), codec.stringify({ filters: { and: ['file.folder == "people"'] }, views: [{ type: "table", name: "Current members" }, { type: "cards", name: "Cards" }] }))
  const before = fs.readFileSync(path.join(source, "index.md"), "utf8")
  let stage
  try {
    const built = prepareSite(source, codec)
    stage = built.stage
    const read = (slug) => fs.readFileSync(path.join(built.output, slug + ".md"), "utf8")
    assert.match(read("index"), /Real about text/)
    assert.doesNotMatch(read("index"), /Welcome to the group/)
    assert.match(read("people/index"), /person-card/)
    assert.match(read("people/directory/index"), /"aliases":\["people\/Directory"\]/)
    assert.match(read("onboarding/welcome"), /Welcome to the group/)
    assert.match(read("people/amy"), /Amy's biography/)
    assert.match(read("materials/index"), /Material data stays here/)
    const table = JSON.parse(fs.readFileSync(path.join(built.output, "people/directory/contacts.base"), "utf8"))
    assert.equal(table.views.length, 1)
    assert.equal(table.views[0].type, "table")
    assert.equal(fs.readFileSync(path.join(source, "index.md"), "utf8"), before)
    assert.ok(fs.existsSync(path.join(source, "people/Directory.base")))
  } finally {
    fs.rmSync(source, { recursive: true })
    if (stage) fs.rmSync(stage, { recursive: true })
  }
})

test("preparation removes source-control ignores from the staged site", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "hafezi-vault-"))
  const codec = { parse: JSON.parse, stringify: (value) => JSON.stringify(value) + "\n" }
  fs.writeFileSync(path.join(source, ".gitignore"), "**/*_files/\n")
  fs.writeFileSync(path.join(source, "index.md"), '---\n{"title":"Private"}\n---\n')
  const prepared = prepareSite(source, codec, { mode: "internal" })
  try {
    assert.equal(fs.existsSync(path.join(prepared.output, ".gitignore")), false)
  } finally {
    fs.rmSync(prepared.stage, { recursive: true, force: true })
    fs.rmSync(source, { recursive: true, force: true })
  }
})
