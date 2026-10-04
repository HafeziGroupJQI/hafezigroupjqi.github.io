import assert from "node:assert/strict"
import test from "node:test"
import { CompletionContext } from "@codemirror/autocomplete"
import { EditorSelection, EditorState } from "@codemirror/state"
import { pageCompletionSource, runFormat } from "./index.js"
import {
  MAX_OPTIONS,
  completionQuery,
  linkFor,
  matchScore,
  pageEntries,
  rankPages,
  siteHref,
  wikilinkText,
} from "./pages.js"

// A slice of the members site's content index (static/contentIndex.json).
const INDEX = {
  "people/mohammad-hafezi": {
    slug: "people/mohammad-hafezi",
    filePath: "people/mohammad-hafezi.md",
    title: "Mohammad Hafezi",
  },
  "people/alumni/index": {
    slug: "people/alumni/index",
    filePath: "people/alumni/index.md",
    title: "Alumni",
  },
  "equipment/santec-tsl": {
    slug: "equipment/santec-tsl",
    filePath: "equipment/santec-tsl.md",
    title: "Santec TSL-570",
  },
  "resources/equipment/santec-tsl": {
    slug: "resources/equipment/santec-tsl",
    filePath: "resources/equipment/santec-tsl.md",
    title: "Santec TSL documents",
  },
  "resources/code/anish-photonics-jumpstart/flight_guide": {
    slug: "resources/code/anish-photonics-jumpstart/flight_guide",
    filePath: "resources/code/anish-photonics-jumpstart/FLIGHT_GUIDE.md",
    title: "Silicon Photonics in One Flight",
  },
  "resources/onboarding/index": {
    slug: "resources/onboarding/index",
    filePath: "resources/onboarding/index.md",
    title: "Onboarding",
  },
  "tags/people": { slug: "tags/people", filePath: "tags/people.md", title: "people" },
  calendar: { slug: "calendar", filePath: "calendar.md", title: "Group calendar" },
  index: { slug: "index", filePath: "index.md", title: "Hafezi Group" },
}

const entries = pageEntries(INDEX)
const bySlug = (slug) => entries.find((entry) => entry.slug === slug)

test("offers the site's pages, not tag listings or member tools", () => {
  assert.deepEqual(entries.map((entry) => entry.slug).sort(), [
    "equipment/santec-tsl",
    "index",
    "people/alumni/index",
    "people/mohammad-hafezi",
    "resources/code/anish-photonics-jumpstart/flight_guide",
    "resources/equipment/santec-tsl",
    "resources/onboarding/index",
  ])
  assert.equal(bySlug("resources/onboarding/index").private, true)
  assert.equal(bySlug("people/alumni/index").private, false)
  assert.deepEqual(pageEntries(null), [])
})

test("links each page as the document's vault writes it", () => {
  const flight = bySlug("resources/code/anish-photonics-jumpstart/flight_guide")
  const person = bySlug("people/mohammad-hafezi")
  // An announcement: everything, by its path on the site (the file's own case, as Quartz reads it).
  assert.deepEqual(linkFor(flight, "site"), {
    wiki: "resources/code/anish-photonics-jumpstart/FLIGHT_GUIDE",
    href: "/resources/code/anish-photonics-jumpstart/flight_guide",
  })
  assert.deepEqual(linkFor(person, "site"), {
    wiki: "people/mohammad-hafezi",
    href: "/people/mohammad-hafezi",
  })
  // The public vault: its own pages only.
  assert.equal(linkFor(flight, "vault"), null)
  assert.deepEqual(linkFor(bySlug("people/alumni/index"), "vault"), {
    wiki: "people/alumni/index",
    href: "/people/alumni/",
  })
  // The private vault: its pages from its top (prepare-unified's privateLink, the preview's
  // linkTarget), public ones as site-absolute Markdown links (its check reads wikilinks as its own).
  assert.deepEqual(linkFor(flight, "vault-private"), {
    wiki: "code/anish-photonics-jumpstart/FLIGHT_GUIDE",
    href: null,
  })
  assert.deepEqual(
    linkFor(bySlug("resources/onboarding/index"), "vault-private").wiki,
    "onboarding/index",
  )
  assert.deepEqual(linkFor(person, "vault-private"), {
    wiki: null,
    markdown: "[Mohammad Hafezi](/people/mohammad-hafezi)",
    href: "/people/mohammad-hafezi",
  })
  assert.equal(siteHref("index"), "/")
})

test("writes [[path|Title]], with a title that can't end the link", () => {
  assert.equal(wikilinkText("people/x", "X Y"), "[[people/x|X Y]]")
  assert.equal(wikilinkText("notes/a|b", "A [draft] | b"), "[[notes/a|b|A draft b]]")
  assert.equal(wikilinkText("notes/a", "notes/a"), "[[notes/a]]")
})

test("knows when the text before the cursor is a link being typed", () => {
  assert.deepEqual(completionQuery("see [[santec"), {
    kind: "wiki",
    embed: false,
    query: "santec",
    start: 4,
    from: 6,
  })
  assert.deepEqual(completionQuery("![[fig")?.embed, true)
  assert.equal(completionQuery("![[fig")?.start, 0)
  assert.deepEqual(completionQuery("[[")?.query, "")
  assert.equal(completionQuery("[[people/x|Moh"), null)
  assert.equal(completionQuery("[[a]] then"), null)
  assert.deepEqual(completionQuery("a [link](/peo"), {
    kind: "link",
    embed: false,
    query: "/peo",
    start: null,
    from: 9,
  })
  assert.equal(completionQuery("[x](https://exa"), null)
  assert.equal(completionQuery("plain text"), null)
})

test("ranks by title and path, best first", () => {
  const titles = (query, options) =>
    rankPages(entries, query, options).map(({ entry }) => entry.title)
  assert.deepEqual(titles("santec").slice(0, 2), ["Santec TSL-570", "Santec TSL documents"])
  assert.equal(titles("moh")[0], "Mohammad Hafezi")
  assert.equal(titles("hafezi")[0], "Hafezi Group")
  // Fuzzy: letters in order, in the title or the path.
  assert.equal(titles("slcn phtncs")[0], "Silicon Photonics in One Flight")
  assert.equal(titles("flight_guide")[0], "Silicon Photonics in One Flight")
  assert.deepEqual(titles("zzzz"), [])
  // What the document's vault can link.
  assert.deepEqual(titles("santec", { mode: "vault" }), ["Santec TSL-570"])
  assert.deepEqual(titles("santec", { mode: "vault-private", kind: "link" }), ["Santec TSL-570"])
  assert.deepEqual(titles("santec", { mode: "vault-private", kind: "wiki", embed: true }), [
    "Santec TSL documents",
  ])
  assert.ok(matchScore(bySlug("index"), "") > 0)
  const many = pageEntries(
    Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`p${i}`, { slug: `notes/p${i}`, title: `Page ${i}` }]),
    ),
  )
  assert.equal(rankPages(many, "page").length, MAX_OPTIONS)
})

async function complete(doc, { mode = "site", explicit = false } = {}) {
  const state = EditorState.create({ doc, selection: { anchor: doc.indexOf("|") } })
  const text = doc.replace("|", "")
  const clean = EditorState.create({ doc: text, selection: { anchor: doc.indexOf("|") } })
  const source = pageCompletionSource({ mode, pages: Promise.resolve(INDEX) })
  const result = await source(new CompletionContext(clean, doc.indexOf("|"), explicit))
  if (!result) return null
  // Apply the first option to a stand-in view that keeps the state.
  const view = {
    state: clean,
    dispatch(spec) {
      this.state = this.state.update(spec).state
    },
  }
  result.options[0].apply(view, result.options[0], result.from, result.to)
  return { result, text: view.state.doc.toString(), cursor: view.state.selection.main.head, state }
}

test("completes [[ in an editor with the page's link, closing brackets kept once", async () => {
  const done = await complete("Talk to [[moh|]] today")
  assert.equal(done.result.options[0].label, "Mohammad Hafezi")
  assert.equal(done.result.options[0].detail, "people/mohammad-hafezi")
  assert.equal(done.text, "Talk to [[people/mohammad-hafezi|Mohammad Hafezi]] today")
  assert.equal(done.cursor, "Talk to [[people/mohammad-hafezi|Mohammad Hafezi]]".length)
  const open = await complete("[[flight|")
  assert.equal(
    open.text,
    "[[resources/code/anish-photonics-jumpstart/FLIGHT_GUIDE|Silicon Photonics in One Flight]]",
  )
  const privateNote = await complete("See [[moh|", { mode: "vault-private" })
  assert.equal(privateNote.text, "See [Mohammad Hafezi](/people/mohammad-hafezi)")
  const link = await complete("a [b](/alum|", {})
  assert.equal(link.text, "a [b](/people/alumni/)")
  const closed = await complete("a [b](/alum|) c", {})
  assert.equal(closed.text, "a [b](/people/alumni/) c")
  // Not for a link's target before it looks like a path, nor in plain text.
  assert.equal(await complete("a [b](alum|"), null)
  assert.equal(await complete("plain moh|"), null)
})

test("formats every selection of an editor at once, and not a read-only one", () => {
  const view = {
    state: EditorState.create({
      doc: "one two three",
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(8, 13),
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    }),
    dispatch(...specs) {
      this.state = this.state.update(...specs).state
    },
  }
  assert.equal(runFormat(view, "bold"), true)
  assert.equal(view.state.doc.toString(), "**one** two **three**")
  assert.deepEqual(
    view.state.selection.ranges.map((r) => view.state.sliceDoc(r.from, r.to)),
    ["one", "three"],
  )
  assert.equal(runFormat(view, "bold"), true)
  assert.equal(view.state.doc.toString(), "one two three")
  view.state = EditorState.create({ doc: "x", extensions: [EditorState.readOnly.of(true)] })
  assert.equal(runFormat(view, "bold"), false)
  assert.equal(runFormat(view, "nope"), false)
})
