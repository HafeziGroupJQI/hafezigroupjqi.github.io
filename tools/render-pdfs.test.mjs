import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { chromium } from "playwright-core"
import * as sass from "sass"
import yaml from "yaml"
import { joinStyles } from "../quartz/util/theme.ts"
import {
  articlePart,
  assetFile,
  hasExportMenu,
  MAX_PDF_BYTES,
  openBrowser,
  pageAssets,
  pageKey,
  pdfPages,
  pdfTarget,
  printPage,
  renderPdfs,
  siteFile,
} from "./render-pdfs.mjs"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const temporary = (t, prefix) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test("pages with an export menu print to /pdf/<slug>.pdf; a member tool's page doesn't", (t) => {
  const page =
    '<div class="page-tools" data-page-tools="true" data-source="/people/index.md"></div>'
  assert.equal(hasExportMenu(page), true)
  assert.equal(hasExportMenu(`${page}<div class="member-tools calendar">`), false)
  assert.equal(hasExportMenu('<div data-page-toolsx="1">'), false)
  // An automatic folder page has tools (Upload to this folder) and no source: never printed.
  assert.equal(
    hasExportMenu('<div class="page-tools" data-page-tools="true" data-folder="notes/a"></div>'),
    false,
  )
  assert.deepEqual(pdfTarget("people/index.html"), {
    slug: "people/index",
    url: "https://hafezigroupjqi.github.io/people/",
    pdf: "pdf/people/index.pdf",
  })
  assert.equal(pdfTarget("index.html").url, "https://hafezigroupjqi.github.io/")
  assert.equal(
    pdfTarget("people/tomás-lee.html", "https://example.org/").url,
    "https://example.org/people/tom%C3%A1s-lee",
  )

  const out = temporary(t, "render-pdfs-")
  fs.mkdirSync(path.join(out, "people"))
  fs.writeFileSync(path.join(out, "people", "index.html"), page)
  fs.writeFileSync(path.join(out, "calendar.html"), `${page}<div class="member-tools">`)
  fs.writeFileSync(path.join(out, "tags.html"), "<p>no tools</p>")
  fs.mkdirSync(path.join(out, "pdf"))
  fs.writeFileSync(path.join(out, "pdf", "old.pdf"), "%PDF-")
  assert.deepEqual(
    pdfPages(out).map((entry) => entry.slug),
    ["people/index"],
  )
  // An earlier run's PDFs are cleared; a page of the site under /pdf/ is an error.
  assert.equal(fs.existsSync(path.join(out, "pdf")), false)
  fs.mkdirSync(path.join(out, "pdf"))
  fs.writeFileSync(path.join(out, "pdf", "notes.html"), page)
  assert.throws(() => pdfPages(out), /\/pdf\/ is reserved .* pdf\/notes\.html/)
})

test("site paths resolve as the site serves them, never outside the build", (t) => {
  const out = temporary(t, "render-pdfs-")
  fs.mkdirSync(path.join(out, "people"))
  fs.writeFileSync(path.join(out, "people", "index.html"), "")
  fs.writeFileSync(path.join(out, "people", "ana.html"), "")
  fs.writeFileSync(path.join(out, "logo.png"), "")
  assert.equal(siteFile(out, "/people/"), path.join(out, "people", "index.html"))
  assert.equal(siteFile(out, "/people"), path.join(out, "people", "index.html"))
  assert.equal(siteFile(out, "/people/ana"), path.join(out, "people", "ana.html"))
  assert.equal(siteFile(out, "/logo.png"), path.join(out, "logo.png"))
  assert.equal(siteFile(out, "/missing"), null)
  assert.equal(siteFile(out, "/../etc/passwd"), null)
  assert.equal(siteFile(out, "/%E0%A4%A"), null)
  assert.equal(
    assetFile(out, path.join(out, "people", "ana.html"), "../logo.png"),
    path.join(out, "logo.png"),
  )
  assert.equal(assetFile(out, path.join(out, "people", "ana.html"), "../../outside.png"), null)
})

test("a page's cache key follows its pictures and print code, and optionally only its article", (t) => {
  const html =
    '<link href="../index-1234abcd.css"><div class="page-content__main"><h1>T</h1><img src="../a.png" srcset="../b.webp 2x, https://x.org/c.png 3x"></div><aside class="page-content__aside"></aside><script src="/static/page-export.js"></script>'
  assert.deepEqual(pageAssets(html), ["../a.png", "../b.webp"])
  assert.equal(articlePart(html).startsWith('class="page-content__main"><h1>T</h1>'), true)
  const out = temporary(t, "render-pdfs-")
  fs.mkdirSync(path.join(out, "p"))
  fs.writeFileSync(path.join(out, "a.png"), "one")
  const file = path.join(out, "p", "x.html")
  const key = (overrides = {}) =>
    pageKey({
      html,
      file,
      output: out,
      version: "v1",
      fileHash: (target) => fs.readFileSync(target, "utf8"),
      ...overrides,
    })
  const first = key()
  assert.equal(key(), first)
  assert.notEqual(key({ version: "v2" }), first)
  fs.writeFileSync(path.join(out, "a.png"), "two")
  assert.notEqual(key(), first)
  // The article scope ignores the stylesheet's name; the full key doesn't.
  const other = html.replace("index-1234abcd", "index-99999999")
  assert.notEqual(key({ html: other }), key())
  assert.equal(key({ html: other, scope: "article" }), key({ scope: "article" }))
})

// The kitchen sink (tools/fixtures/print/kitchen-sink.html) in a site of its own: the site's
// stylesheets compiled from quartz/styles/ as the build does, the Export menu's bundle, KaTeX's
// stylesheet and the theme's fonts; no network.
async function kitchenSink(t) {
  const out = temporary(t, "render-pdfs-site-")
  const theme = yaml.parse(fs.readFileSync(path.join(repo, "quartz.config.yaml"), "utf8"))
    .configuration.theme
  const compile = (name) => sass.compile(path.join(repo, "quartz", "styles", name)).css
  fs.writeFileSync(
    path.join(out, "index.css"),
    `@layer quartz-base {\n${joinStyles(theme, compile("base.scss"))}\n}\n${compile("custom.scss")}`,
  )
  fs.mkdirSync(path.join(out, "static"))
  fs.symlinkSync(path.join(repo, "quartz", "static", "theme"), path.join(out, "static", "theme"))
  const katex = path.dirname(createRequire(import.meta.url).resolve("katex/dist/katex.min.css"))
  fs.symlinkSync(katex, path.join(out, "katex"))
  await build({
    entryPoints: [path.join(repo, "frontend", "page-export", "index.js")],
    outfile: path.join(out, "static", "page-export.js"),
    bundle: true,
    format: "esm",
    logLevel: "warning",
  })
  // The long code block and the wide tables.
  const span = (color, text) =>
    `<span style="--shiki-light:${color};--shiki-dark:${color}">${text}</span>`
  const lines = Array.from({ length: 119 }, (_, i) =>
    i === 5
      ? span("#24292E", "    token = ") +
        span("#032F62", `"${"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo".repeat(6)}"`)
      : i % 9 === 0
        ? span("#D73A49", "def ") + span("#6F42C1", `step_${i}`) + span("#24292E", "(x, y):")
        : span("#24292E", `    value_${i} = compute(`) +
          span("#032F62", `"parameter-${i}"`) +
          span(
            "#24292E",
            `, x * ${i}, y) + offset  # a comment long enough to wrap onto a second line`,
          ),
  )
  const code = `<figure data-rehype-pretty-code-figure=""><pre tabindex="0" data-language="python" data-theme="github-light github-dark"><code data-language="python" data-theme="github-light github-dark" style="display: grid;">${lines.map((line) => `<span data-line="">${line}</span>`).join("\n")}</code></pre></figure>`
  const table = (columns, rows) =>
    `<div class="table-container"><table><thead><tr>${Array.from({ length: columns }, (_, c) => `<th>Column ${c + 1} heading</th>`).join("")}</tr></thead><tbody>${Array.from({ length: rows }, (_, r) => `<tr>${Array.from({ length: columns }, (_, c) => `<td>${c ? (r * 3.14159 + c).toFixed(4) : `Row ${r + 1}`}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
  const html = fs
    .readFileSync(path.join(repo, "tools", "fixtures", "print", "kitchen-sink.html"), "utf8")
    .replace("<!-- print-fixture: code 119 -->", code)
    .replace("<!-- print-fixture: table 12x6 -->", table(12, 6))
    .replace("<!-- print-fixture: table 20x5 -->", table(20, 5))
    // A restricted page's transclusion (tools/acl/lists.mjs), which no PDF prints.
    .replace(
      '<div class="markdown-preview-view markdown-rendered">',
      '$&<div data-acl="r1"><p>A restricted transclusion</p></div>',
    )
  fs.mkdirSync(path.join(out, "setups"))
  fs.writeFileSync(path.join(out, "setups", "kitchen-sink.html"), html)
  return out
}

const hasBrowser = () =>
  chromium.launch().then(
    (browser) => browser.close().then(() => true),
    () => false,
  )

// What the page looks like as it prints (checked in the page, under print media).
function inspectPrint() {
  const visible = (node) => node.getClientRects().length > 0
  const article = document.querySelector(".page-body")
  const restricted = document.querySelectorAll("[data-acl]").length
  const code = [...article.querySelectorAll("pre > code")].map((node) => ({
    lines: node.querySelectorAll(":scope > [data-line]").length,
    digits: node.getAttribute("data-line-numbers-max-digits"),
    keep: node.parentElement.classList.contains("print-keep"),
    wrap: getComputedStyle(node.parentElement).whiteSpace,
    // Each line's number is on the first line of its code: the ::before box starts the line.
    gutter: getComputedStyle(node.querySelector("[data-line]"), "::before").width,
  }))
  const embeds = [...article.querySelectorAll("iframe, video, audio")].map((node) => ({
    hidden: !visible(node),
    note: node.nextElementSibling?.classList.contains("print-embed")
      ? node.nextElementSibling.textContent.trim()
      : null,
    picture: node.nextElementSibling?.querySelector("img")?.getAttribute("src") ?? null,
  }))
  return {
    chrome: [
      ".site-header",
      ".site-footer",
      ".page-content__sidebar",
      ".page-content__aside",
      ".page-content__after",
      ".public-breadcrumbs",
      ".page-tools",
      ".page-file-tools",
      ".wl-guide-nav",
      ".gpt-fab",
      "[data-footnote-backref]",
      "button",
    ].filter((selector) => [...document.querySelectorAll(selector)].some(visible)),
    meta: visible(document.querySelector(".print-meta")),
    refs: [...article.querySelectorAll("sup.print-ref")].map((node) => node.textContent),
    links: [...article.querySelectorAll(".print-links li")].map((node) => node.textContent),
    code,
    embeds,
    details: [...article.querySelectorAll("details")].every((node) => node.open),
    callouts: [...article.querySelectorAll(".callout .callout-content")].map(
      (node) => node.getBoundingClientRect().height,
    ),
    // (YouTube's thumbnail comes from its host, which this test's renderer blocks.)
    images: [...article.querySelectorAll("img:not(.print-embed img)")].map((node) => ({
      src: node.getAttribute("src").slice(0, 40),
      loaded: node.complete && node.naturalWidth > 0,
      width: node.getBoundingClientRect().width,
    })),
    column: article.getBoundingClientRect().width,
    restricted,
    manipulate: getComputedStyle(article.querySelector(".wl-manipulate"), "::after").content,
    theme: getComputedStyle(document.querySelector("thead th")).backgroundColor,
    adjust: getComputedStyle(document.documentElement).printColorAdjust,
  }
}

test("the kitchen sink prints with every case handled, then comes from the cache", async (t) => {
  if (!(await hasBrowser())) return t.skip("no headless Chromium (npm run setup:browser)")
  const out = await kitchenSink(t)
  const { browser, context, blocked } = await openBrowser({ output: out, allowed: new Set() })
  let printed
  try {
    const page = await context.newPage()
    printed = await printPage(
      page,
      { url: "https://hafezigroupjqi.github.io/setups/kitchen-sink" },
      { inspect: inspectPrint },
    )
  } finally {
    await browser.close()
  }
  const seen = printed.inspected
  // Nothing of the site's chrome or controls prints; the title block does. Nor anything of a
  // restricted page's.
  assert.deepEqual(seen.chrome, [])
  assert.equal(seen.restricted, 0)
  assert.equal(seen.meta, true)
  // External links: numbered once per address (a trailing slash is the same one), none for the
  // site's own, anchors, tags, a link that reads as its address or an email link that does.
  assert.deepEqual(seen.refs, ["[1]", "[1]", "[2]", "[3]"])
  assert.deepEqual(seen.links, [
    "https://arxiv.org/abs/2403.00001",
    "lab@example.org",
    "https://example.org/a/very/long/path/that/goes/on",
  ])
  assert.equal(printed.prepared.notes, 3)
  // Code: a three-digit gutter for 119 lines, wrapped lines, short blocks kept whole.
  assert.deepEqual(
    seen.code.map(({ lines, digits, keep, wrap }) => [lines, digits, keep, wrap]),
    [
      [119, "3", false, "pre-wrap"],
      [3, null, true, "pre-wrap"],
    ],
  )
  assert.equal(seen.code[0].gutter, "48px")
  // Embeds: hidden, each with a note and its address; YouTube's with its thumbnail.
  assert.deepEqual(
    seen.embeds.map((embed) => embed.hidden),
    [true, true, true, true],
  )
  assert.match(seen.embeds[0].note, /^Video: www\.youtube\.com\/watch\?v=dQw4w9WgXcQ$/)
  assert.equal(seen.embeds[0].picture, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")
  assert.match(seen.embeds[1].note, /^Embedded PDF: manual\.pdf \(open it from the online page\)$/)
  assert.match(seen.embeds[2].note, /^Video: demo\.mp4$/)
  assert.match(seen.embeds[3].note, /^Audio: tone\.wav$/)
  assert.match(seen.manipulate, /Interactive/)
  // Folded content is open.
  assert.equal(seen.details, true)
  assert.ok(seen.callouts.every((height) => height > 0))
  // Every picture loaded (but the one from a blocked host) and fits the column.
  assert.deepEqual(
    seen.images.filter((image) => !image.loaded).map((image) => image.src),
    ["https://example.com/blocked.png"],
  )
  assert.ok(seen.images.every((image) => image.width <= seen.column + 1))
  // Too wide: both tables and the long equation were zoomed to fit; nothing runs off the page.
  assert.deepEqual(
    printed.fitted.map(({ element, fits }) => [element, fits]),
    [
      ["table", true],
      ["table", true],
      ["equation", true],
    ],
  )
  assert.ok(printed.fitted[0].zoom >= 0.6 && printed.fitted[0].zoom < 1)
  assert.equal(printed.fitted[1].squeezed, true)
  assert.deepEqual(printed.overflow, [])
  // The site's colours print (the dark table header), backgrounds included.
  assert.equal(seen.theme, "rgb(34, 34, 34)")
  assert.equal(seen.adjust, "exact")
  assert.ok(blocked.has("https://example.com/blocked.png"))
  // A tagged PDF with bookmarks, the language and live links.
  const text = printed.pdf.toString("latin1")
  assert.ok(text.startsWith("%PDF-"))
  assert.match(text, /\/StructTreeRoot/)
  assert.match(text, /\/Outlines/)
  assert.match(text, /\/Lang \(en\)/)
  assert.ok((text.match(/\/Subtype \/Link/g) ?? []).length >= 6)
})

test("a second run of the same site prints nothing: every page comes from the cache", async (t) => {
  if (!(await hasBrowser())) return t.skip("no headless Chromium (npm run setup:browser)")
  const out = await kitchenSink(t)
  const cache = temporary(t, "render-pdfs-cache-")
  const run = () =>
    renderPdfs(out, { cache, allowed: new Set(), report: null, log: () => {}, jobs: 1 })
  const first = await run()
  assert.deepEqual([first.summary.printed, first.summary.cached, first.summary.failed], [1, 0, 0])
  const bytes = fs.readFileSync(path.join(out, "pdf", "setups", "kitchen-sink.pdf"))
  const second = await run()
  assert.deepEqual([second.summary.printed, second.summary.cached], [0, 1])
  assert.deepEqual(fs.readFileSync(path.join(out, "pdf", "setups", "kitchen-sink.pdf")), bytes)
  assert.deepEqual(fs.readdirSync(path.join(cache, "public")).length, 1)
})

test("a PDF over the size limit isn't kept, printed or from the cache, and says so", async (t) => {
  if (!(await hasBrowser())) return t.skip("no headless Chromium (npm run setup:browser)")
  // The members deploy failed on a 26 MiB page PDF: Workers' assets take 25 MiB a file.
  assert.ok(MAX_PDF_BYTES < 25 * 1024 * 1024)
  const out = await kitchenSink(t)
  const cache = temporary(t, "render-pdfs-cache-")
  const lines = []
  const run = () =>
    renderPdfs(out, {
      cache,
      allowed: new Set(),
      report: null,
      log: (line) => lines.push(line),
      jobs: 1,
      maxBytes: 1000,
    })
  const pdf = path.join(out, "pdf", "setups", "kitchen-sink.pdf")
  const first = await run()
  assert.deepEqual([first.summary.printed, first.summary.tooLarge], [1, 1])
  assert.equal(fs.existsSync(pdf), false)
  assert.ok(lines.some((line) => /kitchen-sink: .* MiB, over .*: no PDF kept/.test(line)))
  const second = await run()
  assert.deepEqual(
    [second.summary.printed, second.summary.cached, second.summary.tooLarge],
    [0, 1, 1],
  )
  assert.equal(fs.existsSync(pdf), false)
})
