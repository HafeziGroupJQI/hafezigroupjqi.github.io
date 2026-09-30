import assert from "node:assert/strict"
import test from "node:test"
import { fromHtml } from "hast-util-from-html"
import {
  frontMatterProblems,
  frontTitle,
  linkTarget,
  qmdForPreview,
  renderPreview,
} from "./preview.js"

const ORIGIN = "https://hafezigroupjqi.github.io"
const SLUGS = [
  "index",
  "people/ada-lovelace",
  "people/index",
  "equipment/laser",
  "resources/notes/meeting",
  "resources/notes/other",
  "resources/code/bend",
]
const page = (text, options = {}) =>
  renderPreview(text, {
    kind: "md",
    repo: "vault",
    path: "content/people/ada-lovelace.md",
    slug: "people/ada-lovelace",
    allSlugs: SLUGS,
    origin: ORIGIN,
    ...options,
  }).html

test("the preview renders GitHub Markdown, math and Obsidian's syntax as the site does", () => {
  const html = page(
    "---\ntitle: Ada\n---\n\n# Hello\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\nSee [[equipment/laser|the laser]] and [[laser]], ==this== and #optics.\n\nInline $x^2$ and\n\n$$\n\\int_0^1 x\\,dx\n$$\n",
  )
  assert.match(html, /<h1>Hello<\/h1>/)
  assert.match(html, /<table>/)
  assert.match(html, /<input type="checkbox" checked disabled>/)
  assert.match(
    html,
    /<a href="https:\/\/hafezigroupjqi\.github\.io\/equipment\/laser" class="internal">the laser<\/a>/,
  )
  // A bare name is found as Quartz finds it: the shortest path to a page of that name.
  assert.match(
    html,
    /<a href="https:\/\/hafezigroupjqi\.github\.io\/equipment\/laser" class="internal">laser<\/a>/,
  )
  assert.match(html, /<mark>this<\/mark>/)
  assert.match(
    html,
    /<a href="https:\/\/hafezigroupjqi\.github\.io\/tags\/optics" class="internal tag-link">#optics<\/a>/,
  )
  assert.match(html, /class="katex"/)
  assert.match(html, /class="katex-display"/)
  // The front matter is the page's title, not text.
  assert.doesNotMatch(html, /title: Ada/)
  assert.equal(frontTitle("---\ntitle: Ada\n---\n"), "Ada")
})

test("embeds become images, sized as Obsidian sizes them", () => {
  const html = page("![[assets/people/ada.jpg|200]]\n\n![[equipment/laser]]\n")
  assert.match(
    html,
    /<img src="https:\/\/hafezigroupjqi\.github\.io\/assets\/people\/ada\.jpg" alt="" width="200">/,
  )
  // A page can't be pulled in here: it is a link to it.
  assert.match(
    html,
    /<a href="https:\/\/hafezigroupjqi\.github\.io\/equipment\/laser" class="internal">laser<\/a>/,
  )
})

test("callouts get the site's markup, a Quarto page's too", () => {
  const html = page("> [!warning]- Careful\n> Hot **laser**.\n\n> Just a quote.\n")
  assert.match(
    html,
    /<blockquote class="callout warning is-collapsible is-collapsed" data-callout="warning">\s*<div class="callout-title"><div class="callout-icon"><\/div><div class="callout-title-inner"><p>Careful<\/p><\/div><\/div>\s*<div class="callout-content"><p>Hot <strong>laser<\/strong>\.<\/p><\/div>/,
  )
  assert.match(html, /<blockquote>\s*<p>Just a quote\.<\/p>\s*<\/blockquote>/)
  assert.match(page("> [!tip]\n> Text.\n"), /callout-title-inner"><p>Tip<\/p>/)

  const qmd = `---\ntitle: Bend\n---\n\n::: {.callout-tip title="Try it"}\nChange the radius.\n:::\n\n::: {.column-margin}\nA margin note.\n:::\n\n\`\`\`{python}\n#| echo: false\nimport numpy as np\n\`\`\`\n`
  assert.equal(
    qmdForPreview(qmd),
    "---\ntitle: Bend\n---\n\n> [!tip] Try it\n> Change the radius.\n\nA margin note.\n\n```python quarto-runs\n#| echo: false\nimport numpy as np\n```\n",
  )
  const rendered = page(qmd, { kind: "qmd" })
  assert.match(rendered, /<blockquote class="callout tip" data-callout="tip">/)
  assert.match(
    rendered,
    /<p class="edit-runs">Runs when the site builds<\/p>\s*<pre><code class="language-python">#\| echo: false/,
  )
  // A fence inside a chunk is text, not a div.
  assert.equal(qmdForPreview("```{r}\n:::\n```\n"), "```r quarto-runs\n:::\n```\n")
})

test("a private page's links name its vault's files, which the site serves under /resources/", () => {
  const options = { repo: "vault-private", path: "notes/meeting.md", allSlugs: SLUGS }
  assert.equal(linkTarget("other", options), "/resources/notes/other")
  assert.equal(linkTarget("code/bend.qmd", options), "/resources/code/bend.qmd")
  assert.equal(linkTarget("figures/plot.png", options), "/resources/notes/figures/plot.png")
  assert.equal(linkTarget("assets/plot.png", options), "/resources/assets/plot.png")
  assert.equal(linkTarget("/equipment/laser", options), "/equipment/laser")
  assert.equal(linkTarget("https://example.com", options), "https://example.com")
  assert.equal(linkTarget("other", { ...options, repo: "vault" }), "other")
  const html = page("[[other|the other note]]", {
    repo: "vault-private",
    path: "notes/meeting.md",
    slug: "resources/notes/meeting",
  })
  assert.match(html, /href="https:\/\/hafezigroupjqi\.github\.io\/resources\/notes\/other"/)
})

test("nothing in the preview runs: scripts, handlers and javascript: links are gone", () => {
  // OWASP's XSS filter evasion cheat sheet, the kinds that apply to Markdown with raw HTML.
  const corpus = [
    "<script>alert(1)</script>",
    "<SCRIPT SRC=//evil.example/x.js></SCRIPT>",
    '<img src="x" onerror="alert(1)">',
    "<img src=x onerror=alert(1)//",
    '<svg onload="alert(1)"><circle r="1"/></svg>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    "[click](javascript:alert(1))",
    "[click](JaVaScRiPt:alert(1))",
    '<a href="jav&#x09;ascript:alert(1)">tab</a>',
    '<a href="vbscript:msgbox(1)">vb</a>',
    '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">data</a>',
    '<object data="javascript:alert(1)"></object>',
    '<embed src="javascript:alert(1)">',
    "<style>body{display:none}</style>",
    '<div style="background:url(javascript:alert(1))">styled</div>',
    '<form action="javascript:alert(1)"><button formaction="javascript:alert(1)">go</button></form>',
    '<details open ontoggle="alert(1)"><summary>x</summary></details>',
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    '<base href="javascript:alert(1)//">',
    '<link rel="stylesheet" href="//evil.example/x.css">',
    "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>",
    '<input autofocus onfocus="alert(1)">',
    '<body onload="alert(1)">',
    '<video><source onerror="alert(1)"></video>',
    "![x](javascript:alert(1))",
    "[[javascript:alert(1)|wiki]]",
    '<a href="https://example.com" onclick="alert(1)">ok</a>',
  ]
  // KaTeX runs after sanitizing, and makes no links of its own: \href and \url stay text.
  assert.doesNotMatch(
    page("$\\href{javascript:alert(1)}{x}$ and $\\url{javascript:alert(2)}$"),
    /href="\s*javascript:/i,
  )
  // Read back as a browser would parse it: what's text is text; every element is checked.
  const forbidden = new Set([
    "script",
    "iframe",
    "frame",
    "object",
    "embed",
    "style",
    "meta",
    "base",
  ])
  for (const tag of ["link", "form", "svg", "math", "video", "body", "input", "button", "template"])
    forbidden.add(tag)
  const unsafeUrl = /^\s*(?:javascript|vbscript|data):/i
  for (const kind of ["md", "qmd"])
    for (const vector of corpus) {
      const html = page(`---\ntitle: x\n---\n\n${vector}\n\n> [!note] ${vector}\n`, { kind })
      const elements = []
      const walk = (node) => {
        if (node.type === "element") elements.push(node)
        for (const child of node.children ?? []) walk(child)
      }
      walk(fromHtml(html, { fragment: true }))
      for (const element of elements) {
        const where = `${vector} → <${element.tagName}>`
        // A task list's checkbox is the one input GitHub's rules keep (disabled, never focused).
        if (element.tagName === "input") {
          assert.deepEqual(
            Object.keys(element.properties).sort(),
            ["checked", "disabled", "type"].filter((k) => k in element.properties).sort(),
            where,
          )
          continue
        }
        assert.ok(!forbidden.has(element.tagName), where)
        for (const [name, value] of Object.entries(element.properties)) {
          assert.ok(!/^on/i.test(name), `${where} ${name}`)
          assert.ok(!["style", "srcDoc", "formAction", "action"].includes(name), `${where} ${name}`)
          if (["href", "src", "cite", "longDesc"].includes(name))
            assert.doesNotMatch(String(value), unsafeUrl, `${where} ${name}=${value}`)
        }
      }
    }
})

test("front matter problems name their line", () => {
  assert.deepEqual(frontMatterProblems("---\ntitle: Ada\n---\n"), [])
  assert.deepEqual(frontMatterProblems("---\ntype: person\n---\n"), [
    { line: 2, message: "no title" },
  ])
  assert.equal(frontMatterProblems("no front matter")[0].line, 1)
  // The line in the file: the front matter's third line is the file's fourth.
  assert.deepEqual(frontMatterProblems("---\ntitle: Ada\ntags: [a, b\nplace: x\n---\n"), [
    {
      line: 4,
      message: "Flow sequence in block collection must be sufficiently indented and end with a ]",
    },
  ])
  assert.deepEqual(frontMatterProblems("---\ntitle: Ada\ntitle: Bob\n---\n"), [
    { line: 3, message: "Map keys must be unique" },
  ])
})
