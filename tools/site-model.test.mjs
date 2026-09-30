import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  alumniPage,
  cards,
  peoplePage,
  placesPage,
  relativeUrl,
  rewriteLinks,
  publicationList,
  personWebsite,
  profileContact,
  shorten,
} from "./site-model.mjs"
import { prepareSite } from "./prepare-site.mjs"

const person = (title, group, photo) => ({
  slug: "people/" + title.toLowerCase(),
  fm: { title, type: "person", group, photo, role: "Graduate Student" },
  body: "",
})

test("the people page shows current members and sends alumni to their own page", () => {
  const html = peoplePage([
    person("Zoe", "Graduate Students", "assets/zoe.jpg"),
    person("Amy", "Graduate Students"),
    person("Jo", "Alumni"),
    person("Lee", "Visiting researchers"),
  ])
  assert.equal((html.match(/class="person-card"/g) ?? []).length, 3)
  assert.ok(html.indexOf("people/amy") < html.indexOf("people/zoe"))
  assert.doesNotMatch(html, />Jo</)
  assert.match(html, /href="\.\.\/people\/alumni\/"/)
  assert.match(html, /src="\.\.\/assets\/zoe.jpg"/)
  assert.match(html, /href="\.\.\/people\/directory\/"/)
  assert.doesNotMatch(html, /hidden|display:none/)
})

test("the alumni page uses a compact list", () => {
  const html = alumniPage([person("Jo", "Alumni"), person("Amy", "Graduate Students")])
  assert.match(html, /class="alumni-list"/)
  assert.match(html, />Jo</)
  assert.doesNotMatch(html, />Amy</)
})

test("places group rooms and link occupants to profiles", () => {
  const html = placesPage(
    {
      places: [
        { id: "atlantic", name: "Atlantic", kind: "building", status: "verified" },
        {
          id: "office",
          name: "Shared office",
          kind: "office",
          building: "atlantic",
          room: "2369",
          occupants: ["amy"],
          status: "needs-details",
        },
      ],
    },
    [{ ...person("Amy", "Graduate Students"), slug: "people/amy" }],
  )
  assert.match(html, /Buildings/)
  assert.match(html, /Room 2369/)
  assert.match(html, /details needed/)
  assert.match(html, /href="\.\.\/people\/amy"/)
})

test("summaries stop before they become walls of text", () => {
  assert.equal(shorten("one two three four five", 3), "one two three…")
})

test("nested pages and subpath hosting resolve to the same local records", () => {
  assert.equal(relativeUrl("people/index", "people/amy"), "../people/amy")
  assert.equal(relativeUrl("people/directory/index", "assets/amy.jpg"), "../../assets/amy.jpg")
  assert.equal(
    new URL(relativeUrl("people/index", "people/amy"), "https://example.org/group/people/")
      .pathname,
    "/group/people/amy",
  )
})

test("card text and attributes are escaped, and missing photos are explicit", () => {
  const html = cards([person('<Amy & "Jo">', "Members")], "people/index", { people: true })
  assert.match(html, /&lt;Amy &amp; &quot;Jo&quot;&gt;/)
  assert.match(html, /Photo unavailable/)
  assert.doesNotMatch(html, /<Amy/)
})

test("legacy directory links preserve labels and unrelated resources", () => {
  assert.equal(
    rewriteLinks(
      "[[people/Directory.base|directory]] [[people/index|Directory]] [[people/amy|Amy]]",
    ),
    "[[people/directory/index|directory]] [[people/directory/index|Contact directory]] [[people/amy|Amy]]",
  )
})

test("publication listings preserve authors, venue and year without undefined values", () => {
  const html = publicationList(
    [
      {
        slug: "publications/paper",
        fm: { title: "Paper", authors: ["A", "B"], venue: "PRL", year: 2026 },
      },
    ],
    "index",
  )
  assert.match(html, /A, B · PRL · 2026/)
  assert.doesNotMatch(html, /undefined|null/)
})

test("profiles expose confirmed contact fields without presenting TBD as contact data", () => {
  const html = profileContact({ email: "amy@umd.edu", building: "Atlantic", office: "TBD" })
  assert.match(html, /mailto:amy@umd.edu/)
  assert.match(html, /Atlantic/)
  assert.doesNotMatch(html, /TBD|Office/)
})

test("profiles link a person's own website, but not the jqi page they came from or themselves", () => {
  const source = "https://hafezi.jqi.umd.edu/people/amy"
  const contact = (profile) =>
    profileContact({ email: "amy@umd.edu", profile, source }, "people/amy")
  assert.match(
    contact("https://www.amy.dev"),
    /<dt>Website<\/dt><dd><a href="https:\/\/www\.amy\.dev" rel="me noopener">www\.amy\.dev<\/a><\/dd>/,
  )
  assert.match(
    contact(" https://amy.dev/lab/ "),
    /href="https:\/\/amy\.dev\/lab\/"[^>]*>amy\.dev\/lab</,
  )
  for (const profile of [
    source,
    source + "/",
    "https://hafezigroupjqi.github.io/people/amy",
    "javascript:alert(1)",
    "https://amy.dev/<script>",
    'https://amy.dev/" onmouseover="alert(1)',
    "amy.dev",
    null,
    "",
  ])
    assert.doesNotMatch(contact(profile), /Website|<script|onmouseover/, String(profile))
  assert.match(
    contact("https://amy.dev/?a=1&b='2'"),
    /href="https:\/\/amy\.dev\/\?a=1&amp;b=&#39;2&#39;"/,
  )
  assert.deepEqual(personWebsite({ profile: "http://amy.dev/" }), {
    href: "http://amy.dev/",
    text: "amy.dev",
  })
})

test("preparation builds distinct home, people, directory, alumni, and places pages", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "hafezi-fixture-"))
  // JSON is a YAML subset; inject its codec so this orchestration test needs no packages.
  const codec = { parse: JSON.parse, stringify: (value) => JSON.stringify(value) + "\n" }
  const put = (slug, fm, body) => {
    const filename = path.join(source, slug + ".md")
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, `---\n${codec.stringify(fm)}---\n\n${body}\n`)
  }
  put("index", { title: "Hafezi Group", tags: ["home"] }, "Concise introduction")
  put("people/index", { title: "People" }, "People instructions")
  put(
    "people/directory/index",
    { title: "Contact directory", aliases: ["people/Directory"] },
    "![[people/directory/contacts.base]]",
  )
  put("people/alumni/index", { title: "Alumni" }, "<!-- alumni-directory -->")
  put(
    "people/amy",
    { ...person("Amy", "Graduate Students", "assets/amy.jpg").fm, profile: "https://amy.dev" },
    "![[assets/amy.jpg]]\n\nAmy's biography",
  )
  put(
    "people/jo",
    { ...person("Jo", "Alumni").fm, profile: "https://hafezigroupjqi.github.io/people/jo" },
    "Jo's biography",
  )
  put("places/index", { title: "Places", tags: ["places"] }, "<!-- places-directory -->")
  put("materials/index", { title: "Materials" }, "Material data stays here")
  fs.writeFileSync(
    path.join(source, "people/directory/contacts.base"),
    codec.stringify({ views: [{ type: "table", name: "Current members" }] }),
  )
  fs.writeFileSync(
    path.join(source, "places/places.yml"),
    codec.stringify({
      places: [{ id: "atlantic", name: "Atlantic", kind: "building", status: "verified" }],
    }),
  )
  const before = fs.readFileSync(path.join(source, "index.md"), "utf8")
  let stage
  try {
    const built = prepareSite(source, codec)
    stage = built.stage
    const read = (slug) => fs.readFileSync(path.join(built.output, slug + ".md"), "utf8")
    assert.match(read("index"), /Concise introduction/)
    assert.match(read("people/index"), /person-card/)
    assert.match(read("people/directory/index"), /Contact directory/)
    assert.match(read("people/alumni/index"), /alumni-list/)
    assert.match(read("places/index"), /places-directory/)
    assert.match(read("people/amy"), /Amy's biography/)
    assert.match(read("people/amy"), /<dt>Website<\/dt><dd><a href="https:\/\/amy\.dev"/)
    assert.doesNotMatch(read("people/jo"), /Website/)
    assert.match(read("materials/index"), /Material data stays here/)
    // Recently modified is members only: the public build has no such page.
    assert.ok(!fs.existsSync(path.join(built.output, "recent.md")))
    assert.equal(fs.readFileSync(path.join(source, "index.md"), "utf8"), before)
    assert.ok(fs.existsSync(path.join(source, "people/directory/contacts.base")))
  } finally {
    fs.rmSync(source, { recursive: true })
    if (stage) fs.rmSync(stage, { recursive: true })
  }
})

test("preparation removes source-control ignores from the staged site", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "hafezi-vault-"))
  const codec = { parse: JSON.parse, stringify: (value) => JSON.stringify(value) + "\n" }
  fs.mkdirSync(path.join(source, "_freeze", "notes"), { recursive: true })
  fs.writeFileSync(path.join(source, "_freeze", "notes", "result.json"), "{}")
  fs.writeFileSync(path.join(source, ".gitignore"), "**/*_files/\n")
  fs.writeFileSync(path.join(source, "index.md"), '---\n{"title":"Private"}\n---\n')
  const prepared = prepareSite(source, codec, { mode: "internal" })
  try {
    assert.equal(fs.existsSync(path.join(prepared.output, ".gitignore")), false)
    assert.equal(fs.existsSync(path.join(prepared.output, "_freeze")), false)
    assert.equal(
      fs.existsSync(path.join(prepared.stage, "_freeze", "content", "notes", "result.json")),
      true,
    )
  } finally {
    fs.rmSync(prepared.stage, { recursive: true, force: true })
    fs.rmSync(source, { recursive: true, force: true })
  }
})
