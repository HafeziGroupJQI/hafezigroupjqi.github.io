import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import sharp from "sharp"
import {
  AssetStore,
  assetPath,
  numberCells,
  pageBody,
  protectHtml,
  resolveNotebookLinks,
  uniqueTitles,
  writeWolframPages,
} from "./wolfram-pages.mjs"

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wolfram-pages-"))
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex")

// An exporter cache with one noisy PNG (WebP wins), one flat PNG, and an SVG.
async function exporterCache(dir) {
  const assets = path.join(dir, "assets")
  fs.mkdirSync(assets, { recursive: true })
  const put = (bytes, ext, width, height) => {
    const hash = sha(bytes)
    fs.writeFileSync(path.join(assets, `${hash}.${ext}`), bytes)
    return { sha: hash, ext, bytes: bytes.length, width, height }
  }
  const noise = Buffer.alloc(64 * 64 * 3)
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919) % 251
  const png = await sharp(noise, { raw: { width: 64, height: 64, channels: 3 } })
    .png()
    .toBuffer()
  const frame = (r) =>
    sharp({ create: { width: 40, height: 20, channels: 3, background: { r, g: 0, b: 0 } } })
      .png()
      .toBuffer()
  const svg = Buffer.from(
    `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10pt" height="10pt" viewBox="0 0 10 10">  <!-- comment -->\n<rect x="0" y="0" width="10" height="10" fill="#ff0000"/></svg>`,
  )
  return {
    png: put(png, "png", 32, 32),
    svg: put(svg, "svg", 10, 10),
    frames: [put(await frame(10), "png", 20, 10), put(await frame(200), "png", 20, 10)],
  }
}

test("protectHtml encodes Obsidian syntax in text but not in tags or entities", () => {
  const html = protectHtml('<a href="/x#y">list[[2]] #tag $x ==hi== %%c%% &amp; &#x3C;</a>\n\nnext')
  assert.equal(
    html,
    '<a href="/x#y">list&#91;&#91;2&#93;&#93; &#35;tag &#36;x &#61;&#61;hi&#61;&#61; &#37;&#37;c&#37;&#37; &amp; &#x3C;</a>&#10;\nnext',
  )
  assert.doesNotMatch(html, /\n\s*\n/)
})

test("numberCells gives each input an id and the earlier definitions as its prelude", () => {
  const cells = numberCells([
    { t: "input", code: "x = 1", def: true },
    { t: "output" },
    { t: "input", code: "x + 1", def: false },
    { t: "input", code: "f[y_] := y", def: true },
    { t: "input", code: "f[x]", def: false },
  ])
  const inputs = cells.filter((cell) => cell.t === "input")
  assert.deepEqual(
    inputs.map((cell) => [cell.id, cell.prelude]),
    [
      ["c1", []],
      ["c2", ["c1"]],
      ["c3", ["c1"]],
      ["c4", ["c1", "c3"]],
    ],
  )
})

test("AssetStore converts PNG to WebP when smaller, minifies SVG, and reuses conversions", async () => {
  const dir = temp()
  const assets = await exporterCache(dir)
  const out = path.join(dir, "out")
  const store = new AssetStore({ outDir: out, cacheDir: dir, sourceDir: path.join(dir, "assets") })
  const webp = await store.convert(assets.png)
  assert.match(webp, /^[0-9a-f]{32}\.(webp|png)$/)
  assert.ok(fs.existsSync(path.join(out, assetPath(webp))))
  const svg = await store.convert(assets.svg)
  assert.match(svg, /\.svg$/)
  assert.doesNotMatch(fs.readFileSync(path.join(out, assetPath(svg)), "utf8"), /comment/)
  assert.equal(store.stats.converted, 2)
  const again = new AssetStore({ outDir: out, cacheDir: dir, sourceDir: path.join(dir, "assets") })
  assert.equal(await again.convert(assets.png), webp)
  assert.equal(again.stats.reused, 1)
  const sprite = await store.sprite(assets.frames)
  assert.deepEqual(
    { cols: sprite.cols, rows: sprite.rows, width: sprite.width, height: sprite.height },
    { cols: 2, rows: 1, width: 20, height: 10 },
  )
  const meta = await sharp(path.join(out, assetPath(sprite.name))).metadata()
  assert.equal(meta.format, "webp")
  assert.equal(meta.width, 80)
})

test("AssetStore converts again after an interrupted run, and leaves no partial files", async () => {
  const dir = temp()
  const assets = await exporterCache(dir)
  const out = path.join(dir, "out")
  const store = new AssetStore({ outDir: out, cacheDir: dir, sourceDir: path.join(dir, "assets") })
  await store.convert(assets.svg)
  const index = fs.readdirSync(store.cacheDir).filter((name) => name.endsWith(".json"))
  assert.equal(index.length, 1)
  assert.deepEqual(
    fs.readdirSync(store.cacheDir, { recursive: true }).filter((name) => name.endsWith(".tmp")),
    [],
  )
  // A run killed while writing left half an index entry: the next run converts again.
  fs.writeFileSync(path.join(store.cacheDir, index[0]), '{"na')
  const again = new AssetStore({ outDir: out, cacheDir: dir, sourceDir: path.join(dir, "assets") })
  assert.match(await again.convert(assets.svg), /\.svg$/)
  assert.deepEqual(again.stats, { converted: 1, reused: 0, webp: 0, svgo: again.stats.svgo })
})

test("pageBody renders the cell contract the client mounts on", async () => {
  const dir = temp()
  const assets = await exporterCache(dir)
  const store = new AssetStore({
    outDir: path.join(dir, "out"),
    cacheDir: dir,
    sourceDir: path.join(dir, "assets"),
  })
  const notebook = {
    page: "resources/demo/manipulate",
    blocks: [
      { t: "caption", html: 'Define <code class="wl-inline">x</code>:' },
      { t: "input", code: "x = {1, 2, 3}", def: true },
      { t: "output", style: "Output", out: { kind: "text", text: "{1, 2, 3}" } },
      { t: "input", code: "x[[2]]", def: false },
      { t: "output", style: "Output", out: { kind: "image", asset: assets.svg } },
      {
        t: "output",
        style: "Output",
        out: {
          kind: "manipulate",
          snapshot: assets.png,
          frames: assets.frames,
          controls: [{ name: "n", label: "n", values: ["1", "2"] }],
        },
      },
      { t: "question", html: "Why?" },
      { t: "answer", html: "Because {{asset:" + assets.svg.sha + ".svg}}" },
      { t: "exercise", num: "9.1", html: "Try it." },
      { t: "expected", out: { kind: "text", text: "6" } },
    ],
  }
  const body = await pageBody(notebook, {
    store,
    symbolsUrl: "/notebook-assets/ab/s.json",
    source: "demo/manipulate.nb",
    download: { href: "/resources/demo/manipulate.nb", name: "manipulate.nb" },
  })
  assert.match(
    body,
    /^<div class="wl-notebook" data-wolfram-notebook data-page="resources\/demo\/manipulate" data-source="demo\/manipulate.nb" data-symbols="\/notebook-assets\/ab\/s.json">/,
  )
  assert.match(
    body,
    /<p class="wl-source">Rendered from <a class="internal" href="\/resources\/demo\/manipulate.nb">manipulate.nb<\/a><\/p>/,
  )
  assert.match(
    body,
    /<figure class="wl-cell" id="c1" data-page="resources\/demo\/manipulate" data-cell="c1" data-def>/,
  )
  assert.match(
    body,
    /<figure class="wl-cell" id="c2" data-page="resources\/demo\/manipulate" data-cell="c2" data-prelude="c1">/,
  )
  assert.match(body, /<pre class="wl-code shiki/)
  assert.match(body, /x&#91;&#91;2&#93;&#93;|&#91;&#91;/)
  assert.doesNotMatch(body, /\[\[/)
  assert.match(
    body,
    /<div class="wl-manipulate" data-sprite="\/notebook-assets\/[0-9a-f]{2}\/[0-9a-f]{32}\.webp" data-cols="2" data-rows="1"/,
  )
  assert.match(
    body,
    /<div class="wl-qa"><p class="wl-question">Why\?<\/p><div class="wl-answer"><p>Because \/notebook-assets\/[0-9a-f]{2}\/[0-9a-f]{32}\.svg/,
  )
  assert.match(body, /<details class="wl-expected"><summary>Expected output<\/summary>/)
  for (const block of body.split("\n\n")) assert.doesNotMatch(block, /\n[ \t]*\n/)
})

// A stage-1 render dir (render-nb.wls output) for the given notebooks, keyed by their bytes, with
// the path each was rendered from (relative to its stage-1 root) when given.
async function stage1Dir(dir, notebooks) {
  const assets = await exporterCache(dir)
  const out = path.join(dir, "render")
  fs.mkdirSync(path.join(out, "notebooks"), { recursive: true })
  fs.cpSync(path.join(dir, "assets"), path.join(out, "assets"), { recursive: true })
  for (const [name, bytes, title, blocks, source] of notebooks)
    fs.writeFileSync(
      path.join(out, "notebooks", `${name}.json`),
      JSON.stringify({
        source,
        source_sha: sha(Buffer.from(bytes)),
        title,
        exporter_version: "3",
        wolfram_version: 15,
        blocks: blocks(assets),
        stats: { failed: [] },
      }),
    )
  fs.writeFileSync(path.join(out, "render.json"), JSON.stringify({ failed: [] }))
  fs.writeFileSync(
    path.join(out, "symbols.json"),
    JSON.stringify([{ n: "Table", u: "Table[expr, n]" }]),
  )
  return out
}

test("writeWolframPages puts a page next to every notebook, matched by the notebook's bytes", async () => {
  const dir = temp()
  const content = path.join(dir, "content")
  fs.mkdirSync(path.join(content, "resources", "guide"), { recursive: true })
  fs.mkdirSync(path.join(content, "public"), { recursive: true })
  const put = (rel, bytes) => fs.writeFileSync(path.join(content, rel), bytes)
  put("resources/guide/01-start.nb", "Notebook[{1}]")
  put("resources/guide/01-start-exercises.nb", "Notebook[{2}]")
  put("public/demo.nb", "Notebook[{3}]")
  put("resources/guide/unrendered.nb", "Notebook[{4}]") // no render of these bytes
  put("resources/guide/clash.nb", "Notebook[{5}]")
  put("resources/guide/clash.md", "---\ntitle: hand-written\n---\n")
  const render = await stage1Dir(dir, [
    [
      "a",
      "Notebook[{1}]",
      "Starting Out",
      (assets) => [
        { t: "input", code: "2 + 2", def: false },
        { t: "output", out: { kind: "image", asset: assets.png } },
        { t: "exsummary", text: "9" },
      ],
    ],
    ["b", "Notebook[{2}]", "Starting Out", () => [{ t: "exercise", num: "1.1", html: "Compute." }]],
    ["c", "Notebook[{3}]", "Demo", () => [{ t: "p", html: "Hello" }]],
    ["d", "Notebook[{5}]", "Clash", () => [{ t: "p", html: "x" }]],
  ])
  const assetsDir = path.join(dir, "notebook-assets")
  const result = await writeWolframPages({
    contentDir: content,
    renderDirs: [render],
    assetsDir,
    cacheDir: dir,
    forkPrefix: "resources/",
  })
  assert.deepEqual(
    result.missing.map((m) => m.source),
    ["resources/guide/unrendered.nb"],
  )
  assert.deepEqual(result.conflicts, [
    { source: "resources/guide/clash.nb", page: "resources/guide/clash.md" },
  ])
  assert.deepEqual(result.pages.map((p) => [p.page, p.title, p.inputs, p.outputs]).sort(), [
    ["public/demo.md", "Demo", 0, 0],
    ["resources/guide/01-start-exercises.md", "Starting Out (01-start-exercises)", 0, 0],
    ["resources/guide/01-start.md", "Starting Out (01-start)", 1, 1],
  ])
  const page = fs.readFileSync(path.join(content, "resources/guide/01-start.md"), "utf8")
  assert.match(
    page,
    /^---\ntitle: Starting Out \(01-start\)\ntags:\n {2}- internal\n {2}- notebook\n {2}- notebook\/wolfram\n/,
  )
  assert.match(page, /rendered_from: resources\/guide\/01-start.nb\n/)
  assert.match(page, new RegExp(`source_sha: ${sha(Buffer.from("Notebook[{1}]"))}`))
  // Forkable only under the private vault's prefix, by its path inside the vault.
  assert.match(page, /data-source="guide\/01-start.nb"/)
  assert.doesNotMatch(fs.readFileSync(path.join(content, "public/demo.md"), "utf8"), /data-source=/)
  assert.match(page, /<p class="wl-exsummary">9 exercises<\/p>/)
  // The raw notebook is linked at the path the site serves it: Quartz's (lower-case) slug.
  assert.match(
    page,
    /Rendered from <a class="internal" href="\/resources\/guide\/01-start.nb">01-start.nb<\/a>/,
  )
  // The hand-written page is left alone.
  assert.match(
    fs.readFileSync(path.join(content, "resources/guide/clash.md"), "utf8"),
    /hand-written/,
  )
  for (const [name, entry] of result.assets) {
    assert.equal(entry.path, assetPath(name))
    assert.ok(fs.existsSync(path.join(assetsDir, entry.path)))
  }
  const img = page.match(/src="\/notebook-assets\/([0-9a-f]{2}\/[0-9a-f]{32}\.(webp|png))"/)
  assert.ok(img && fs.existsSync(path.join(assetsDir, img[1])))
})

test("byte-identical notebooks at different paths each get the render of their own path", async () => {
  const dir = temp()
  const content = path.join(dir, "content")
  fs.mkdirSync(path.join(content, "resources", "guide"), { recursive: true })
  fs.mkdirSync(path.join(content, "resources", "copies"), { recursive: true })
  fs.mkdirSync(path.join(content, "code"), { recursive: true })
  for (const rel of ["resources/guide/intro.nb", "resources/copies/intro-copy.nb", "code/demo.nb"])
    fs.writeFileSync(path.join(content, rel), "Notebook[{6}]")
  // Without a title cell, each render is titled by its file name. The private vault is rendered
  // from its own root, so its sources lack the staged resources/ prefix.
  const render = await stage1Dir(dir, [
    ["a", "Notebook[{6}]", "intro", () => [{ t: "p", html: "x" }], "guide/intro.nb"],
    ["b", "Notebook[{6}]", "intro-copy", () => [{ t: "p", html: "x" }], "copies/intro-copy.nb"],
    ["c", "Notebook[{6}]", "demo", () => [{ t: "p", html: "x" }], "code/demo.nb"],
  ])
  const result = await writeWolframPages({
    contentDir: content,
    renderDirs: [render],
    assetsDir: path.join(dir, "notebook-assets"),
    cacheDir: dir,
  })
  assert.deepEqual(result.pages.map((p) => [p.page, p.title]).sort(), [
    ["code/demo.md", "demo"],
    ["resources/copies/intro-copy.md", "intro-copy"],
    ["resources/guide/intro.md", "intro"],
  ])
})

test("uniqueTitles only disambiguates titles shared within one folder", () => {
  assert.deepEqual(
    uniqueTitles([
      { rel: "a/x.nb", title: "T" },
      { rel: "a/y.nb", title: "T" },
      { rel: "b/z.nb", title: "T" },
    ]).map((entry) => entry.title),
    ["T (x)", "T (y)", "T"],
  )
})

test("links between notebooks go to deployed pages; missing targets stay plain text", () => {
  const deployed = new Set(["resources/guide/01 Start & Go.nb", "resources/other/x.nb"])
  const html =
    '<p>See <a class="internal" href="{{nb:01 Start &amp; Go.nb}}">chapter 1</a>, ' +
    '<a class="internal" href="{{nb:../other/x.nb}}">x</a> and ' +
    '<a class="internal" href="{{nb:41-MoreAboutPatterns.nb}}">the <code>sort</code></a>.</p>'
  assert.equal(
    resolveNotebookLinks(html, "resources/guide/02.nb", deployed),
    '<p>See <a class="internal" href="/resources/guide/01-start--and--go">chapter 1</a>, ' +
      '<a class="internal" href="/resources/other/x">x</a> and the <code>sort</code>.</p>',
  )
})

test("pruning keeps only the conversions this run used, and drops older converters", async () => {
  const dir = temp()
  const assets = await exporterCache(dir)
  const out = path.join(dir, "out")
  const first = new AssetStore({ outDir: out, cacheDir: dir, sourceDir: path.join(dir, "assets") })
  await first.convert(assets.png)
  const svg = await first.convert(assets.svg)
  fs.mkdirSync(path.join(dir, "post", "an-older-converter"), { recursive: true })
  // The next deploy cites only the SVG.
  const second = new AssetStore({
    outDir: path.join(dir, "out2"),
    cacheDir: dir,
    sourceDir: path.join(dir, "assets"),
  })
  assert.equal(await second.convert(assets.svg), svg)
  assert.ok(second.prune() >= 3)
  assert.deepEqual(fs.readdirSync(path.join(dir, "post")), [second.cacheDir.split(path.sep).pop()])
  assert.deepEqual(fs.readdirSync(path.join(second.cacheDir, "files")), [svg])
  assert.equal(fs.readdirSync(second.cacheDir).filter((f) => f.endsWith(".json")).length, 1)
})
