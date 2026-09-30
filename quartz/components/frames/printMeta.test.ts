import test, { describe } from "node:test"
import assert from "node:assert"
import { render } from "preact-render-to-string"
import { h } from "preact"
import { PrintMeta, authorsText, cssString, dateText, printMeta, printTitle } from "./printMeta"

describe("printMeta", () => {
  test("strings for the running header are CSS strings that can't end their <style>", () => {
    assert.strictEqual(cssString("Setup 1: bench"), '"Setup 1: bench"')
    assert.strictEqual(cssString('The "best" \\ path'), '"The \\"best\\" \\\\ path"')
    assert.strictEqual(cssString("two\nlines\r\nthree"), '"two\\a lines\\a three"')
    assert.strictEqual(cssString("</style><script>"), '"\\3c /style>\\3c script>"')
  })

  test("the running header's title is one line of at most 70 characters", () => {
    assert.strictEqual(printTitle("  Setup 1:\n main  bench "), "Setup 1: main bench")
    const long = "Topologically Robust Transport of Photons in a Synthetic Gauge Field on Arxiv"
    assert.strictEqual(
      printTitle(long),
      "Topologically Robust Transport of Photons in a Synthetic Gauge Field…",
    )
    assert.strictEqual(printTitle("x".repeat(80)).length, 70)
  })

  test("authors read as a byline, with et al. after three", () => {
    assert.strictEqual(authorsText(undefined), null)
    assert.strictEqual(authorsText([]), null)
    assert.strictEqual(authorsText("Anish Goyal"), "Anish Goyal")
    assert.strictEqual(authorsText(["A. One", "B. Two"]), "A. One and B. Two")
    assert.strictEqual(authorsText(["A", "B", "C"]), "A, B and C")
    assert.strictEqual(authorsText(["A", "B", "C", "D"]), "A, B, C et al.")
    assert.strictEqual(authorsText(["A", null, " ", "B"]), "A and B")
  })

  test("a date alone is that day; a date and time is its day in New York", () => {
    assert.strictEqual(dateText("2026-09-14"), "September 14, 2026")
    assert.strictEqual(dateText(new Date(Date.UTC(2026, 8, 14))), "September 14, 2026")
    // 01:30 UTC on the 15th is still the 14th at the lab.
    assert.strictEqual(dateText("2026-09-15T01:30:00Z"), "September 14, 2026")
    assert.strictEqual(dateText("2026-09-14T10:00:00-04:00"), "September 14, 2026")
    assert.strictEqual(dateText(""), null)
    assert.strictEqual(dateText("someday"), null)
  })

  test("a page's title block: edition, trail, byline, date and address", () => {
    const meta = printMeta({
      slug: "resources/journal-club/journal-club-01",
      title: "Journal Club 1",
      trail: ["Resources", "Journal Club"],
      baseUrl: "hafezigroupjqi.github.io",
      members: true,
      frontmatter: { authors: ["Anish Goyal"], date: "2026-09-10" },
    })
    assert.deepStrictEqual(meta, {
      brand: "Hafezi Group · Members only",
      title: "Journal Club 1",
      url: "https://hafezigroupjqi.github.io/resources/journal-club/journal-club-01",
      address: "hafezigroupjqi.github.io/resources/journal-club/journal-club-01",
      members: true,
      trail: "Hafezi Group › Resources › Journal Club",
      authors: "Anish Goyal",
      date: "September 10, 2026",
    })
    // An index page's address is its folder's; the home page's is the site's.
    const home = { title: "Home", trail: [], baseUrl: "hafezigroupjqi.github.io", members: false }
    assert.strictEqual(
      printMeta({ ...home, slug: "people/index" }).address,
      "hafezigroupjqi.github.io/people/",
    )
    assert.strictEqual(
      printMeta({ ...home, slug: "index" }).url,
      "https://hafezigroupjqi.github.io/",
    )
    assert.strictEqual(printMeta({ ...home, slug: "index" }).brand, "Hafezi Group")
    // A publication's citation has its authors and year; its front matter date is a month's.
    const publication = printMeta({
      ...home,
      slug: "publications/x",
      frontmatter: { type: "publication", authors: ["A"], date: "2014-09-01" },
    })
    assert.deepStrictEqual([publication.authors, publication.date], [null, null])
  })

  test("the frame renders the title block and the header's strings", () => {
    const html = render(
      h(PrintMeta, {
        slug: "resources/notes/a",
        title: 'A "quoted" <title>',
        trail: ["Resources"],
        baseUrl: "hafezigroupjqi.github.io",
        members: true,
        frontmatter: { author: "Anish Goyal", date: "2026-09-14" },
      }),
    )
    assert.strictEqual(
      html,
      '<style>:root{--print-brand:"Hafezi Group · Members only";--print-title:"A \\"quoted\\" \\3c title>";--print-url:"hafezigroupjqi.github.io/resources/notes/a"}</style>' +
        '<div class="print-meta"><span class="print-meta__edition">Members only</span> · ' +
        "Hafezi Group › Resources · By Anish Goyal · September 14, 2026 · " +
        '<a href="https://hafezigroupjqi.github.io/resources/notes/a">hafezigroupjqi.github.io/resources/notes/a</a></div>',
    )
    const plain = render(
      h(PrintMeta, { slug: "lab-facilities", title: "Lab Facilities", trail: [], members: false }),
    )
    assert.strictEqual(
      plain,
      '<style>:root{--print-brand:"Hafezi Group";--print-title:"Lab Facilities";--print-url:""}</style><div class="print-meta">Hafezi Group</div>',
    )
  })
})
