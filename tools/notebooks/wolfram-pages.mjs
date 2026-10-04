// Stage 2 of the site's notebook step: turns stage-1 renders of Wolfram notebooks (render-nb.wls,
// block JSON per notebook plus the raw assets) into pages, one next to each .nb in the staged
// content: <dir>/x.nb -> <dir>/x.md (frontmatter + raw HTML cell blocks), with its figures,
// sounds and Manipulate sprites content-addressed under the assets directory, which the site
// serves at /notebook-assets/<sha2>/<name>.
//
// A notebook gets a page only from a render of exactly its bytes: renders are matched to the
// staged notebooks by sha256, and a notebook without one is an error, so a page can never come
// from anything but the source being deployed.
//
// PNGs become WebP (quality 85) when that is smaller, SVGs are minified with svgo, and
// Manipulate frames are composed into one WebP sprite grid. Conversions are cached by input sha.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import sharp from "sharp"
import { optimize } from "svgo"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import yaml from "yaml"
import { slugifyFilePath } from "@quartz-community/utils"
import { blobSha } from "../docs-manifest.mjs"

export const ASSET_URL = "/notebook-assets/"
const MAX_ASSET_BYTES = 24 * 1024 * 1024
const MAX_SPRITE_EDGE = 16000

export const contentTypes = {
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  json: "application/json",
  mp4: "video/mp4",
  webm: "video/webm",
}

export const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex")
// 128 bits is plenty to address a few thousand files and keeps URLs short.
export const assetName = (bytes, ext) => `${sha256(bytes).slice(0, 32)}.${ext}`
export const assetPath = (name) => `${name.slice(0, 2)}/${name}`

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// The pages go through Quartz's Markdown pipeline, whose Obsidian syntax (wikilinks [[...]],
// #tags, $math$, ==highlights==, %%comments%%, ^block-refs) would rewrite Wolfram code such as
// list[[2]] or #^2&. Encode those characters in text (never inside tags), and keep every block
// free of blank lines so CommonMark treats it as one HTML block.
export function protectHtml(html) {
  return html
    .split(/(<[^>]*>)/)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]\w*);|[[\]#$%=^~*_`\\|]/gi, (match) =>
            match.length > 1 ? match : `&#${match.charCodeAt(0)};`,
          ),
    )
    .join("")
    .replace(/\n(?=[ \t]*\n)/g, "&#10;")
}

export function frontmatter(data) {
  return `---\n${yaml.stringify(data)}---\n`
}

// Assign ids to code cells and, for each, the ids of the earlier definition cells it may depend on.
export function numberCells(blocks) {
  const definitions = []
  let n = 0
  return blocks.map((block) => {
    if (block.t !== "input") return block
    const id = `c${++n}`
    const numbered = { ...block, id, prelude: [...definitions] }
    if (block.def && !block.norun) definitions.push(id)
    return numbered
  })
}

// ---------- assets ----------

// A dependency's version, from the package.json above its entry point (svgo exports no package.json).
function packageVersion(name) {
  let dir = path.dirname(createRequire(import.meta.url).resolve(name))
  while (dir !== path.dirname(dir)) {
    const file = path.join(dir, "package.json")
    if (fs.existsSync(file)) {
      const json = JSON.parse(fs.readFileSync(file, "utf8"))
      if (json.name === name) return json.version
    }
    dir = path.dirname(dir)
  }
  return "unknown"
}

// Conversions (WebP, svgo, sprites) are cached per converter: this file's bytes and the image
// libraries' versions. Changing any of them converts afresh; nothing stale is reused.
export const CONVERTER = crypto
  .createHash("sha256")
  .update(fs.readFileSync(fileURLToPath(import.meta.url)))
  .update(JSON.stringify(sharp.versions))
  .update(packageVersion("svgo"))
  .digest("hex")
  .slice(0, 16)

// Write a cache file whole or not at all: a job killed mid-write must not leave a truncated file
// that a later deploy would take for a finished one.
function writeAtomic(file, data) {
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, data)
  fs.renameSync(temp, file)
}

export class AssetStore {
  constructor({ outDir, cacheDir, sourceDir }) {
    this.outDir = outDir
    this.sourceDir = sourceDir
    this.postRoot = path.join(cacheDir, "post")
    this.cacheDir = path.join(this.postRoot, CONVERTER)
    this.keys = new Set() // conversion cache entries this run used
    fs.mkdirSync(this.cacheDir, { recursive: true })
    this.used = new Map()
    // The assets the page being written cites (writeWolframPages), by path under ASSET_URL.
    this.page = null
    this.stats = { converted: 0, reused: 0, webp: 0, svgo: 0 }
  }

  record(name, bytes) {
    this.page?.add(assetPath(name))
    const file = path.join(this.outDir, assetPath(name))
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, bytes)
    }
    const ext = path.extname(name).slice(1)
    this.used.set(name, {
      path: assetPath(name),
      size: bytes.length,
      contentType: contentTypes[ext],
    })
    return name
  }

  cached(key) {
    const file = path.join(this.cacheDir, `${key}.json`)
    if (!fs.existsSync(file)) return null
    let entry
    try {
      entry = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
      return null // written by an older, interrupted run: convert again
    }
    const out = path.join(this.outDir, assetPath(entry.name))
    const stash = path.join(this.cacheDir, "files", entry.name)
    const source = fs.existsSync(out) ? out : fs.existsSync(stash) ? stash : null
    if (!source) return null
    this.keys.add(key)
    this.stats.reused++
    return this.record(entry.name, fs.readFileSync(source))
  }

  remember(key, name, bytes) {
    const stash = path.join(this.cacheDir, "files", name)
    if (!fs.existsSync(stash)) {
      fs.mkdirSync(path.dirname(stash), { recursive: true })
      writeAtomic(stash, bytes)
    }
    writeAtomic(path.join(this.cacheDir, `${key}.json`), JSON.stringify({ name }))
    this.keys.add(key)
    this.stats.converted++
    return this.record(name, bytes)
  }

  // Keep only what this run used: older converters' entries, and conversions of assets no page
  // cites any more, go (the deploy's cache is restored whole, so it would otherwise only grow).
  prune() {
    let removed = 0
    for (const dir of fs.existsSync(this.postRoot) ? fs.readdirSync(this.postRoot) : [])
      if (dir !== CONVERTER)
        (fs.rmSync(path.join(this.postRoot, dir), { recursive: true, force: true }), removed++)
    for (const file of fs.readdirSync(this.cacheDir).filter((name) => name.endsWith(".json")))
      if (!this.keys.has(file.slice(0, -5))) (fs.rmSync(path.join(this.cacheDir, file)), removed++)
    const stash = path.join(this.cacheDir, "files")
    for (const name of fs.existsSync(stash) ? fs.readdirSync(stash) : [])
      if (!this.used.has(name)) (fs.rmSync(path.join(stash, name)), removed++)
    return removed
  }

  // An exporter asset (<sha256>.<ext> in the exporter cache) → its final site name.
  async convert(asset) {
    if (!asset?.sha) return null
    const key = `${asset.sha}.${asset.ext}`
    const hit = this.cached(key)
    if (hit) return hit
    const source = path.join(this.sourceDir, key)
    if (!fs.existsSync(source)) throw new Error(`missing exporter asset ${key}`)
    let bytes = fs.readFileSync(source)
    let ext = asset.ext
    if (ext === "png") {
      const webp = await sharp(bytes).webp({ quality: 85, effort: 5 }).toBuffer()
      if (webp.length < bytes.length) {
        bytes = webp
        ext = "webp"
        this.stats.webp++
      }
    } else if (ext === "svg") {
      const result = optimize(bytes.toString("utf8"), {
        multipass: true,
        plugins: ["preset-default"],
      })
      bytes = Buffer.from(result.data)
      this.stats.svgo++
    }
    if (bytes.length > MAX_ASSET_BYTES) return null
    return this.remember(key, assetName(bytes, ext), bytes)
  }

  // Compose Manipulate frames into one row-major WebP grid.
  async sprite(frames) {
    const key = `sprite-${sha256(frames.map((frame) => frame.sha).join(","))}`
    const hit = this.cached(key)
    const cols = Math.min(frames.length, 8)
    const rows = Math.ceil(frames.length / cols)
    const inputs = frames.map((frame) => path.join(this.sourceDir, `${frame.sha}.${frame.ext}`))
    const metas = hit ? null : await Promise.all(inputs.map((file) => sharp(file).metadata()))
    const cssWidth = Math.max(...frames.map((frame) => frame.width))
    const cssHeight = Math.max(...frames.map((frame) => frame.height))
    const layout = { cols, rows, width: cssWidth, height: cssHeight }
    if (hit) return { name: hit, ...layout }
    let cellWidth = Math.max(...metas.map((meta) => meta.width))
    let cellHeight = Math.max(...metas.map((meta) => meta.height))
    const scale = Math.min(
      1,
      MAX_SPRITE_EDGE / (cellWidth * cols),
      MAX_SPRITE_EDGE / (cellHeight * rows),
    )
    cellWidth = Math.floor(cellWidth * scale)
    cellHeight = Math.floor(cellHeight * scale)
    const tiles = await Promise.all(
      inputs.map(async (file, index) => ({
        input: await sharp(file)
          .resize({
            width: Math.max(1, Math.floor(metas[index].width * scale)),
            height: Math.max(1, Math.floor(metas[index].height * scale)),
          })
          .toBuffer(),
        left: (index % cols) * cellWidth,
        top: Math.floor(index / cols) * cellHeight,
      })),
    )
    const bytes = await sharp({
      create: {
        width: cellWidth * cols,
        height: cellHeight * rows,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .composite(tiles)
      .webp({ quality: 85, effort: 5 })
      .toBuffer()
    if (bytes.length > MAX_ASSET_BYTES) return null
    return { name: this.remember(key, assetName(bytes, "webp"), bytes), ...layout }
  }

  json(value) {
    const bytes = Buffer.from(JSON.stringify(value))
    return this.record(assetName(bytes, "json"), bytes)
  }
}

// ---------- HTML ----------

const url = (name) => ASSET_URL + assetPath(name)

async function imageHtml(store, asset, { cls = "wl-img", alt = "" } = {}) {
  const name = await store.convert(asset)
  if (!name) return `<p class="wl-missing">(output too large to include)</p>`
  const size = asset.width && asset.height ? ` width="${asset.width}" height="${asset.height}"` : ""
  return `<img class="${cls}" src="${url(name)}"${size} alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`
}

async function outputHtml(store, out, style = "Output") {
  if (!out) return ""
  switch (out.kind) {
    case "text":
      return `<pre class="wl-text${style === "Message" ? " wl-message" : ""}">${escapeHtml(out.text)}</pre>`
    case "table":
      return `<table class="wl-grid"><tbody>${out.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`
    case "image":
      return imageHtml(store, out.asset, { alt: "Output" })
    case "audio": {
      const sources = []
      for (const [ext, type] of [
        ["ogg", "audio/ogg"],
        ["mp3", "audio/mpeg"],
      ]) {
        const name = out[ext] ? await store.convert(out[ext]) : null
        if (name) sources.push(`<source src="${url(name)}" type="${type}">`)
      }
      if (!sources.length && out.snapshot) return imageHtml(store, out.snapshot, { alt: "Sound" })
      return `<audio class="wl-audio" controls preload="none">${sources.join("")}</audio>`
    }
    case "video": {
      const thumb = await imageHtml(store, out.thumb, { alt: "Video" })
      return out.href
        ? `<a class="wl-video" href="${escapeHtml(out.href)}" target="_blank" rel="noopener">${thumb}<span class="wl-video-label">Play video</span></a>`
        : `<div class="wl-video">${thumb}</div>`
    }
    case "manipulate": {
      const snapshot = await imageHtml(store, out.snapshot, { alt: "Manipulate" })
      if (!out.frames?.length) return `<div class="wl-manipulate-static">${snapshot}</div>`
      const sprite = await store.sprite(out.frames)
      if (!sprite) return `<div class="wl-manipulate-static">${snapshot}</div>`
      const controls = out.controls.map((control) => ({ ...control, initial: 0 }))
      return `<div class="wl-manipulate" data-sprite="${url(sprite.name)}" data-cols="${sprite.cols}" data-rows="${sprite.rows}" data-frame-width="${sprite.width}" data-frame-height="${sprite.height}" data-controls="${escapeHtml(JSON.stringify(controls))}">${snapshot}</div>`
    }
    default:
      return ""
  }
}

// Wolfram code, highlighted with the same Shiki grammar and themes as the site's code blocks.
let highlighterPromise
async function highlight(code) {
  highlighterPromise ??= import("shiki").then(({ createHighlighter }) =>
    createHighlighter({ themes: ["github-light", "github-dark"], langs: ["wolfram"] }),
  )
  const highlighter = await highlighterPromise
  return highlighter
    .codeToHtml(code, {
      lang: "wolfram",
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    })
    .replace(/^<pre class="shiki/, '<pre class="wl-code shiki')
    .replace(/ tabindex="0"/, "")
}

function renderAssets(html, store, pending) {
  return html.replace(/\{\{asset:([0-9a-f]+)\.(\w+)\}\}/g, (match, sha, ext) => {
    const token = `@@asset${pending.length}@@`
    pending.push({ token, asset: { sha, ext } })
    return token
  })
}

async function resolveAssets(html, store) {
  const pending = []
  let text = renderAssets(html, store, pending)
  for (const { token, asset } of pending) {
    const name = await store.convert(asset)
    text = text.replace(token, name ? url(name) : "")
  }
  return text
}

// The page body: the notebook's cells in order, inputs grouped with their outputs into
// <figure class="wl-cell"> elements that frontend/wolfram-notebook/ makes runnable.
// The raw notebook next to a page, as the site serves it (Quartz's slug of its content path; the
// Worker streams private documents at those paths). Absolute, because Quartz resolves a bare
// relative link on a generated page from the site root.
export const documentHref = (contentPath) => "/" + slugifyFilePath(contentPath)

const unescapeHtml = (text) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

/**
 * Links between notebooks: the renderer leaves href="{{nb:<file>}}" (the name the notebook links
 * to, relative to its own folder). A target that is deployed becomes a link to its page; one that
 * isn't (a name from the notebook's authoring system, say) is left as plain text.
 */
export function resolveNotebookLinks(html, pageRel, notebooks) {
  return html.replace(
    /<a ([^>]*?)href="\{\{nb:([^"}]*)\}\}"([^>]*)>([\s\S]*?)<\/a>/g,
    (match, before, name, after, inner) => {
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(pageRel), unescapeHtml(name)),
      )
      if (!notebooks.has(target)) return inner
      return `<a ${before}href="/${slugifyFilePath(target.replace(/\.nb$/, ".md"))}"${after}>${inner}</a>`
    },
  )
}

export async function pageBody(notebook, { store, symbolsUrl, source = null, download = null }) {
  const blocks = numberCells(notebook.blocks)
  const parts = []
  const push = (html) => parts.push(protectHtml(html))
  let open = null // the figure collecting an input and its outputs
  const flush = () => {
    if (open) push(open.join("") + "</div></figure>")
    open = null
  }
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (block.t === "output") {
      const html = await outputHtml(store, block.out, block.style)
      if (open) open.push(html)
      else push(`<div class="wl-out wl-standalone">${html}</div>`)
      continue
    }
    flush()
    switch (block.t) {
      case "input": {
        const attributes = [
          `class="wl-cell"`,
          `id="${block.id}"`,
          `data-page="${escapeHtml(notebook.page)}"`,
          `data-cell="${block.id}"`,
          block.prelude.length ? `data-prelude="${block.prelude.join(" ")}"` : "",
          block.def ? "data-def" : "",
          block.norun ? "data-norun" : "",
          block.label ? `data-label="${escapeHtml(block.label)}"` : "",
        ].filter(Boolean)
        const code = block.code ? await highlight(block.code) : ""
        const display = block.display
          ? await imageHtml(store, block.display, { cls: "wl-img", alt: "Input" })
          : ""
        const label = block.label ? `<span class="wl-label">${escapeHtml(block.label)}</span>` : ""
        open = [
          `<figure ${attributes.join(" ")}>`,
          label,
          display
            ? `<div class="wl-code-img">${display}</div>${code.replace('<pre class="wl-code', '<pre hidden class="wl-code')}`
            : code,
          `<div class="wl-out">`,
        ]
        break
      }
      case "h2":
      case "h3":
      case "h4":
        push(
          `<${block.t}${block.cls ? ` class="${block.cls}"` : ""}>${await resolveAssets(block.html, store)}</${block.t}>`,
        )
        break
      case "p":
      case "caption":
      case "technote":
      case "more":
      case "index": {
        const cls = {
          p: "wl-text-cell",
          caption: "wl-caption",
          technote: "wl-technote",
          more: "wl-more",
          index: `wl-index-entry wl-${String(block.style ?? "index").toLowerCase()}`,
        }[block.t]
        const html = await resolveAssets(block.html, store)
        push(
          block.t === "technote"
            ? `<div class="${cls}"><p>${html}</p></div>`
            : `<p class="${cls}">${html}</p>`,
        )
        break
      }
      case "list":
        push(`<ul class="${block.cls ?? "wl-list"}">${await resolveAssets(block.html, store)}</ul>`)
        break
      case "question": {
        const answers = []
        while (blocks[index + 1]?.t === "answer") answers.push(blocks[++index])
        const body = []
        for (const answer of answers) body.push(`<p>${await resolveAssets(answer.html, store)}</p>`)
        push(
          `<div class="wl-qa"><p class="wl-question">${await resolveAssets(block.html, store)}</p><div class="wl-answer">${body.join("")}</div></div>`,
        )
        break
      }
      case "answer":
        push(`<div class="wl-answer">${await resolveAssets(block.html, store)}</div>`)
        break
      case "vocab":
        push(
          `<table class="wl-vocab"><tbody>${(
            await Promise.all(
              block.rows.map(
                async (row) =>
                  `<tr>${(await Promise.all(row.map(async (cell) => `<td>${await resolveAssets(cell, store)}</td>`))).join("")}</tr>`,
              ),
            )
          ).join("")}</tbody></table>`,
        )
        break
      case "exercise":
        push(
          `<div class="wl-exercise"${block.num ? ` id="ex-${escapeHtml(block.num.replace(/[^\w.]/g, ""))}"` : ""}>${block.num ? `<span class="wl-exnum">${escapeHtml(block.num)}</span>` : ""}<div>${await resolveAssets(block.html, store)}</div></div>`,
        )
        break
      case "expected":
        push(
          `<details class="wl-expected"><summary>Expected output</summary><div class="wl-out">${await outputHtml(store, block.out, "ExerciseOutput")}</div></details>`,
        )
        break
      case "exsummary":
        if (block.text) push(`<p class="wl-exsummary">${escapeHtml(block.text)} exercises</p>`)
        break
      case "error":
        push(`<p class="wl-missing">(This cell could not be rendered.)</p>`)
        break
      default:
        break
    }
  }
  flush()
  const attributes = [
    `class="wl-notebook"`,
    "data-wolfram-notebook",
    `data-page="${escapeHtml(notebook.page)}"`,
    // Where "Open in Scratchpad" forks the notebook from (the compute host's vault mirror).
    source ? `data-source="${escapeHtml(source)}"` : "",
    symbolsUrl ? `data-symbols="${symbolsUrl}"` : "",
  ].filter(Boolean)
  const bar = download
    ? `<p class="wl-source">Rendered from <a class="internal" href="${escapeHtml(download.href)}">${escapeHtml(download.name)}</a></p>`
    : ""
  return [`<div ${attributes.join(" ")}>`, protectHtml(bar), ...parts, `</div>`]
    .filter(Boolean)
    .join("\n\n")
}

// ---------- main ----------

const walk = (directory) =>
  fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name.startsWith(".")) return []
        const file = path.join(directory, entry.name)
        return entry.isDirectory() ? walk(file) : [file]
      })
    : []

export const fileSha = (file) => sha256(fs.readFileSync(file))
const posix = (value) => value.split(path.sep).join("/")

// Stage-1 renders, indexed by the sha256 of the notebook each was made from (a list: byte-identical
// notebooks at different paths each have a render, and their titles can differ).
export function readRenders(dirs) {
  const bySha = new Map()
  const summaries = []
  for (const dir of dirs) {
    const summaryFile = path.join(dir, "render.json")
    if (fs.existsSync(summaryFile)) summaries.push(JSON.parse(fs.readFileSync(summaryFile, "utf8")))
    for (const file of walk(path.join(dir, "notebooks")).filter((f) => f.endsWith(".json"))) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"))
      if (!data.source_sha) continue
      if (!bySha.has(data.source_sha)) bySha.set(data.source_sha, [])
      bySha.get(data.source_sha).push({ ...data, assetsDir: path.join(dir, "assets") })
    }
  }
  const symbolsFile = dirs
    .map((dir) => path.join(dir, "symbols.json"))
    .find((f) => fs.existsSync(f))
  const symbols = symbolsFile ? JSON.parse(fs.readFileSync(symbolsFile, "utf8")) : []
  return { bySha, summaries, symbols }
}

// The render made from the notebook at `rel` among those of its bytes. A render's source is
// relative to its stage-1 root, which the staged content may nest (the private vault under
// resources/). Any of them will do when none was made from this path.
const renderOf = (renders, rel) =>
  renders.find((render) => render.source === rel) ??
  renders.find((render) => rel.endsWith(`/${render.source}`)) ??
  renders[0]

// Two notebooks in one folder with the same title (a chapter and its exercises, say) keep their
// file names in the title so the folder listing stays unambiguous.
export function uniqueTitles(entries) {
  const seen = new Map()
  for (const entry of entries) {
    const key = `${path.dirname(entry.rel)}\u0000${entry.title}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  return entries.map((entry) =>
    seen.get(`${path.dirname(entry.rel)}\u0000${entry.title}`) > 1
      ? { ...entry, title: `${entry.title} (${path.basename(entry.rel, ".nb")})` }
      : entry,
  )
}

/**
 * A staged notebook's path in the private vault, when it is under `forkPrefix` (where the build
 * stages that vault): "Open in Scratchpad" forks it from there as published:<path>. Else null.
 */
export const forkSource = (rel, forkPrefix) =>
  forkPrefix && rel.startsWith(forkPrefix) ? rel.slice(forkPrefix.length) : null

/**
 * Write a page next to every .nb under `contentDir` from the stage-1 renders in `renderDirs`.
 * `forkPrefix`: staged paths under it are forkable into the Scratchpad as published:<rest>.
 * Returns {pages, missing, conflicts, assets, stats}; the caller fails the build on missing or
 * conflicting notebooks.
 */
export async function writeWolframPages({
  contentDir,
  renderDirs,
  assetsDir,
  cacheDir,
  forkPrefix = null,
  prune = false,
}) {
  const { bySha, symbols } = readRenders(renderDirs)
  const notebooks = walk(contentDir).filter((file) => file.endsWith(".nb"))
  const missing = []
  const conflicts = []
  const entries = []
  for (const file of notebooks) {
    const rel = posix(path.relative(contentDir, file))
    const bytes = fs.readFileSync(file)
    const sha = sha256(bytes)
    const render = bySha.has(sha) ? renderOf(bySha.get(sha), rel) : null
    if (!render) {
      missing.push({ source: rel, source_sha: sha })
      continue
    }
    const page = file.replace(/\.nb$/, ".md")
    if (fs.existsSync(page)) {
      conflicts.push({ source: rel, page: posix(path.relative(contentDir, page)) })
      continue
    }
    entries.push({ file, rel, page, sha, blob: blobSha(bytes), render, title: render.title })
  }
  const store = new AssetStore({ outDir: assetsDir, cacheDir, sourceDir: null })
  const deployed = new Set(notebooks.map((file) => posix(path.relative(contentDir, file))))
  const symbolsName = symbols.length && entries.length ? store.json(symbols) : null
  const pages = []
  for (const entry of uniqueTitles(entries)) {
    store.sourceDir = entry.render.assetsDir
    store.page = new Set(symbolsName ? [assetPath(symbolsName)] : [])
    const notebook = { ...entry.render, page: entry.rel.replace(/\.nb$/, "") }
    const source = forkSource(entry.rel, forkPrefix)
    const body = resolveNotebookLinks(
      await pageBody(notebook, {
        store,
        symbolsUrl: symbolsName ? url(symbolsName) : null,
        source,
        download: { href: documentHref(entry.rel), name: path.basename(entry.rel) },
      }),
      entry.rel,
      deployed,
    )
    const inputs = entry.render.blocks.filter((block) => block.t === "input").length
    const outputs = entry.render.blocks.filter((block) => block.t === "output").length
    fs.writeFileSync(
      entry.page,
      frontmatter({
        title: entry.title,
        tags: ["internal", "notebook", "notebook/wolfram"],
        rendered_from: entry.rel,
        notebook: {
          kind: "wolfram",
          source_sha: entry.sha,
          renderer_version: entry.render.exporter_version,
          wolfram_version: entry.render.wolfram_version,
          inputs,
          outputs,
        },
        // Its file in the private vault, for the page's History and its Edit, which opens the
        // notebook in the Scratchpad (the lab's Wolfram notebook editor; JqiFrame's [data-page-tools]).
        ...(source
          ? {
              edit_repo: "vault-private",
              edit_path: source,
              edit_sha: entry.blob,
              edit_mode: "scratchpad",
            }
          : {}),
      }) +
        "\n" +
        body +
        "\n",
    )
    pages.push({
      source: entry.rel,
      page: posix(path.relative(contentDir, entry.page)),
      source_sha: entry.sha,
      title: entry.title,
      inputs,
      outputs,
      failed_cells: entry.render.blocks.filter((block) => block.t === "error").length,
      // Its assets, by path under /notebook-assets/ (the access refs, tools/acl/outputs.mjs).
      assets: [...store.page].sort(),
    })
    store.page = null
  }
  const pruned = prune ? store.prune() : 0
  return { pages, missing, conflicts, assets: store.used, stats: { ...store.stats, pruned } }
}
