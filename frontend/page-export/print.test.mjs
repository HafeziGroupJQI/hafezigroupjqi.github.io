import assert from "node:assert/strict"
import test from "node:test"
import { TOKENS } from "../theme/tokens.js"
import { FLOOR, embedNote, fitZoom, gutterDigits, linkNotes, paperLight } from "./print.js"

const page = "https://hafezigroupjqi.github.io/resources/onboarding/git"

test("links to other sites get a number, one per address, listed in order", () => {
  const { refs, notes } = linkNotes(
    [
      { href: "https://git-scm.com/book", text: "Pro Git" },
      { href: "https://arxiv.org/abs/2403.00001", text: "the preprint" },
      { href: "https://git-scm.com/book/", text: "the book again" },
      { href: "http://git-scm.com/book", text: "over http" },
    ],
    page,
  )
  assert.deepEqual(refs, [1, 2, 1, 3])
  assert.deepEqual(notes, [
    "https://git-scm.com/book",
    "https://arxiv.org/abs/2403.00001",
    "http://git-scm.com/book",
  ])
})

test("the site's own links, anchors, tags and links that read as their address get none", () => {
  const { refs, notes } = linkNotes(
    [
      { href: "https://hafezigroupjqi.github.io/resources/code/", text: "the code index" },
      { href: "https://hafezigroupjqi.github.io/resources/onboarding/git#ssh", text: "SSH" },
      { href: "https://hafezigroupjqi.github.io/tags/git", text: "git" },
      { href: "https://git-scm.com/", text: " https://git-scm.com " },
      { href: "https://www.example.org/a/", text: "example.org/a" },
      { href: "https://example.org/caf%C3%A9", text: "https://example.org/café" },
      { href: "javascript:void(0)", text: "Run" },
      { href: "blob:https://x/1", text: "notebook.ipynb" },
      { href: "data:text/plain,hi", text: "a file" },
      { href: "not a url ::", text: "broken" },
    ],
    page,
  )
  assert.deepEqual(refs, Array(10).fill(null))
  assert.deepEqual(notes, [])
})

test("an email link gets a number when its text isn't the address", () => {
  const { refs, notes } = linkNotes(
    [
      { href: "mailto:hafezi@umd.edu", text: "email the PI" },
      { href: "mailto:hafezi@umd.edu", text: "Hafezi@UMD.edu" },
      { href: "mailto:lab%40umd.edu", text: "the lab" },
    ],
    page,
  )
  assert.deepEqual(refs, [1, null, 2])
  assert.deepEqual(notes, ["hafezi@umd.edu", "lab@umd.edu"])
})

test("embeds print as a note with their address; YouTube with its thumbnail", () => {
  assert.deepEqual(
    embedNote(
      { tag: "iframe", src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0" },
      page,
    ),
    {
      label: "Video",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      text: "www.youtube.com/watch?v=dQw4w9WgXcQ",
      image: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    },
  )
  assert.equal(
    embedNote({ tag: "iframe", src: "https://youtu.be/dQw4w9WgXcQ" }, page).label,
    "Video",
  )
  assert.equal(
    embedNote({ tag: "iframe", src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=4" }, page).url,
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  )
  assert.deepEqual(
    embedNote({ tag: "iframe", src: "https://player.vimeo.com/video/76979871" }, page),
    {
      label: "Video",
      url: "https://vimeo.com/76979871",
      text: "vimeo.com/76979871",
    },
  )
  assert.deepEqual(
    embedNote({ tag: "iframe", src: "../equipment/assets/Manual%20v4.pdf#page=2" }, page),
    {
      label: "Embedded PDF",
      url: "https://hafezigroupjqi.github.io/resources/equipment/assets/Manual%20v4.pdf#page=2",
      text: "Manual v4.pdf",
      hint: "open it from the online page",
    },
  )
  assert.deepEqual(
    embedNote({ tag: "iframe", src: "https://www.desmos.com/calculator/abc" }, page),
    {
      label: "Embedded page",
      url: "https://www.desmos.com/calculator/abc",
      text: "www.desmos.com/calculator/abc",
    },
  )
  assert.deepEqual(
    embedNote({ tag: "video", src: "/assets/run.mp4", poster: "/assets/run.jpg" }, page),
    {
      label: "Video",
      url: "https://hafezigroupjqi.github.io/assets/run.mp4",
      text: "run.mp4",
      image: "https://hafezigroupjqi.github.io/assets/run.jpg",
    },
  )
  assert.deepEqual(embedNote({ tag: "audio", src: "tone.wav" }, page), {
    label: "Audio",
    url: "https://hafezigroupjqi.github.io/resources/onboarding/tone.wav",
    text: "tone.wav",
  })
  // No address to give: a srcdoc frame, a blob.
  assert.equal(embedNote({ tag: "iframe", src: "" }, page), null)
  assert.equal(embedNote({ tag: "video", src: "blob:https://x/1" }, page), null)
})

test("a code block's gutter is as wide as its largest line number, from 10 lines", () => {
  assert.equal(gutterDigits(0), null)
  assert.equal(gutterDigits(9), null)
  assert.equal(gutterDigits(10), 2)
  assert.equal(gutterDigits(119), 3)
  assert.equal(gutterDigits(1000), 4)
})

test("wide content is zoomed to fit with 2% to spare, never below its floor", () => {
  assert.equal(fitZoom(600, 688), 1)
  assert.equal(fitZoom(688, 688), 1)
  assert.equal(fitZoom(846, 786), 0.91)
  assert.equal(fitZoom(1410, 786), 0.6)
  assert.equal(fitZoom(993, 786, FLOOR.equation), 0.77)
  assert.equal(fitZoom(4000, 786, FLOOR.equation), 0.5)
  assert.equal(fitZoom(800, 0), 1)
})

function root(attributes = {}, properties = {}) {
  const attrs = new Map(Object.entries(attributes))
  const props = new Map(Object.entries(properties))
  const style = () => [...props].map(([name, value]) => `${name}: ${value};`).join(" ")
  return {
    attrs,
    props,
    getAttribute: (name) => (name === "style" ? style() || null : (attrs.get(name) ?? null)),
    setAttribute: (name, value) => {
      if (name !== "style") return attrs.set(name, value)
      props.clear()
      for (const part of value.split(";").filter((text) => text.trim())) {
        const [key, ...rest] = part.split(":")
        props.set(key.trim(), rest.join(":").trim())
      }
    },
    removeAttribute: (name) => (name === "style" ? props.clear() : attrs.delete(name)),
    style: { removeProperty: (name) => props.delete(name) },
  }
}

test("paper takes a member's theme off the page, and puts it back after", () => {
  const page = root(
    { "saved-theme": "dark", "data-palette": "nord", "data-figures": "match" },
    { "--light": "#2e3440", "--c-rule": "#434c5e", "--print-title": "x" },
  )
  const restore = paperLight(page)
  assert.deepEqual(Object.fromEntries(page.attrs), { "saved-theme": "light" })
  // Only the theme's tokens go; the page's own properties (the print header's) stay.
  assert.deepEqual(Object.fromEntries(page.props), { "--print-title": "x" })
  assert.ok(TOKENS.includes("--c-rule"))
  restore()
  assert.deepEqual(Object.fromEntries(page.attrs), {
    "saved-theme": "dark",
    "data-palette": "nord",
    "data-figures": "match",
  })
  assert.equal(page.props.get("--light"), "#2e3440")
})

test("the site's own look is left exactly as it is", () => {
  const page = root({}, { "--print-title": "x" })
  assert.equal(paperLight(page), null)
  assert.equal(paperLight(root({ "saved-theme": "light" })), null)
  assert.deepEqual(Object.fromEntries(page.props), { "--print-title": "x" })
})
