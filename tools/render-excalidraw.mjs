import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import LZString from "lz-string"
import { chromium } from "playwright-core"
import yaml from "yaml"

// Drawings are exported by Excalidraw itself in headless Chromium (tools/render-excalidraw-page.mjs).
// The page, its bundle and Excalidraw's fonts are served from memory and the installed package;
// every other request is blocked, so a build never loads code or fonts from the network.
const pageOrigin = "https://excalidraw.invalid"
const excalidrawAssets = path.dirname(fileURLToPath(import.meta.resolve("@excalidraw/excalidraw")))
const fontDirectory = path.join(excalidrawAssets, "fonts")
const pageHtml = `<!doctype html><meta charset="utf-8"><script>window.EXCALIDRAW_ASSET_PATH = "${pageOrigin}/"</script>`

const drawingPattern = /\.excalidraw(?:\.md)?$/
const pagePattern = /\.(?:md|qmd)$/

const walk = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(filename) : [filename]
  })

const normalize = (value) => value.split(path.sep).join("/")

export function parseDrawing(filename, source = fs.readFileSync(filename, "utf8")) {
  let scene
  if (filename.endsWith(".excalidraw")) {
    scene = JSON.parse(source)
  } else {
    const block = source.match(/```(compressed-json|json)\s*\r?\n([\s\S]*?)\r?\n```/)
    if (!block) throw new Error(`${filename}: no Excalidraw JSON block`)
    const decoded =
      block[1] === "compressed-json"
        ? LZString.decompressFromBase64(block[2].replace(/\s/g, ""))
        : block[2]
    if (!decoded) throw new Error(`${filename}: compressed Excalidraw data could not be decoded`)
    scene = JSON.parse(decoded)
  }
  const elements = Array.isArray(scene) ? scene : scene.elements
  if (!Array.isArray(elements) || elements.length === 0)
    throw new Error(`${filename}: drawing has no elements`)
  const files = Object.fromEntries(
    Object.entries(scene.files ?? {}).map(([id, file]) => [
      id,
      { mimeType: file.mimeType, dataURL: file.dataURL },
    ]),
  )
  for (const element of elements.filter((candidate) => candidate.type === "image")) {
    if (!element.fileId || !files[element.fileId])
      throw new Error(`${filename}: missing embedded file ${element.fileId ?? "(unset)"}`)
  }
  return { elements, files }
}

export function drawingOutputPath(root, filename) {
  const relative = normalize(path.relative(root, filename)).replace(/\.excalidraw(?:\.md)?$/, "")
  return path.join(root, "assets", "excalidraw", `${relative}.svg`)
}

const drawingTitle = (filename) => {
  if (!filename.endsWith(".md")) return path.basename(filename).replace(/\.excalidraw$/, "")
  const text = fs.readFileSync(filename, "utf8")
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  const frontmatter = match ? (yaml.parse(match[1]) ?? {}) : {}
  return String(frontmatter.title ?? path.basename(filename).replace(/\.excalidraw\.md$/, ""))
}

export function drawingAliases(root, filename) {
  const relative = normalize(path.relative(root, filename))
  const withoutMarkdown = relative.replace(/\.md$/, "")
  return new Set([
    relative,
    withoutMarkdown,
    path.basename(relative),
    path.basename(withoutMarkdown),
    withoutMarkdown.replace(/\.excalidraw$/, ""),
    path.basename(withoutMarkdown).replace(/\.excalidraw$/, ""),
  ])
}

export function rewriteDrawingEmbeds(text, drawings, pageRelative = "index.md") {
  return text.replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g, (match, raw) => {
    const target = raw.trim().replace(/\\$/, "")
    const candidates = drawings.filter(
      (drawing) => drawing.aliases.has(target) || drawing.aliases.has(path.basename(target)),
    )
    if (candidates.length === 0) return match
    if (candidates.length > 1) throw new Error(`ambiguous Excalidraw embed [[${raw}]]`)
    const drawing = candidates[0]
    const pageDirectory = path.posix.dirname(pageRelative)
    const image = path.posix.relative(pageDirectory, drawing.outputRelative)
    const interactive = path.posix.relative(pageDirectory, drawing.pageRelative)
    return `![${drawing.title}](${image})\n\n[Open interactive drawing](${interactive})`
  })
}

const sanitizeSvg = (filename) => {
  const svg = fs.readFileSync(filename, "utf8")
  if (!/<svg\b/i.test(svg) || !/viewBox=/i.test(svg))
    throw new Error(`${filename}: renderer produced an invalid SVG`)
  if (/<script\b|\son[a-z]+\s*=|(?:href|src)=["']https?:/i.test(svg))
    throw new Error(`${filename}: renderer produced unsafe external content`)
}

async function bundlePage() {
  const outdir = path.resolve("excalidraw-page")
  const result = await build({
    entryPoints: { page: fileURLToPath(new URL("./render-excalidraw-page.mjs", import.meta.url)) },
    bundle: true,
    splitting: true,
    format: "esm",
    outdir,
    write: false,
    define: { "process.env.NODE_ENV": '"production"' },
    // only its text-to-diagram dialog loads Mermaid, never an export
    external: ["@excalidraw/mermaid-to-excalidraw"],
    logLevel: "warning",
  })
  return new Map(
    result.outputFiles.map((file) => [
      `/${normalize(path.relative(outdir, file.path))}`,
      file.text,
    ]),
  )
}

const pageResponse = (bundle, pathname) => {
  if (pathname === "/") return { contentType: "text/html", body: pageHtml }
  if (bundle.has(pathname)) return { contentType: "text/javascript", body: bundle.get(pathname) }
  const font = path.join(excalidrawAssets, decodeURIComponent(pathname))
  if (font.startsWith(fontDirectory + path.sep) && fs.existsSync(font)) return { path: font }
}

async function openRenderer() {
  const bundle = await bundlePage()
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ serviceWorkers: "block" })
    const blocked = []
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url())
      const response = url.origin === pageOrigin && pageResponse(bundle, url.pathname)
      if (response) return route.fulfill(response)
      blocked.push(url.href)
      return route.abort("blockedbyclient")
    })
    const page = await context.newPage()
    page.on("console", (message) => {
      if (message.type() === "error") console.error(`render-excalidraw: ${message.text()}`)
    })
    await page.goto(`${pageOrigin}/`)
    const render = (scene) => {
      let timer
      return Promise.race([
        page.evaluate(
          async ({ entry, elements, files }) =>
            (await import(entry)).renderDrawing(elements, files),
          { entry: `${pageOrigin}/page.js`, ...scene },
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out after 60s")), 60_000)
        }),
      ]).finally(() => {
        clearTimeout(timer)
        if (blocked.length) throw new Error(`blocked requests: ${blocked.join(", ")}`)
      })
    }
    return { render, close: () => browser.close() }
  } catch (error) {
    await browser.close()
    throw error
  }
}

export async function renderDrawings(rootDirectory) {
  const root = fs.realpathSync(rootDirectory)
  const filenames = walk(root).filter((filename) => drawingPattern.test(filename))
  if (filenames.length === 0) {
    console.log("render-excalidraw: no drawings")
    return []
  }

  const renderer = await openRenderer()
  const drawings = []
  try {
    for (const filename of filenames) {
      const output = drawingOutputPath(root, filename)
      fs.mkdirSync(path.dirname(output), { recursive: true })
      const svg = await renderer.render(parseDrawing(filename)).catch((error) => {
        throw new Error(`${filename}: ${error.message}`)
      })
      fs.writeFileSync(output, svg)
      sanitizeSvg(output)
      const relative = normalize(path.relative(root, filename))
      drawings.push({
        aliases: drawingAliases(root, filename),
        outputRelative: normalize(path.relative(root, output)),
        pageRelative: relative.replace(/\.md$/, ""),
        title: drawingTitle(filename),
      })
      console.log(`render-excalidraw: ${relative} -> ${normalize(path.relative(root, output))}`)
    }
  } finally {
    await renderer.close()
  }

  for (const page of walk(root).filter(
    (filename) => pagePattern.test(filename) && !drawingPattern.test(filename),
  )) {
    const before = fs.readFileSync(page, "utf8")
    const after = rewriteDrawingEmbeds(before, drawings, normalize(path.relative(root, page)))
    if (after !== before) fs.writeFileSync(page, after)
  }
  return drawings
}

async function main() {
  const directory = process.argv[2]
  if (!directory) {
    console.error("usage: node tools/render-excalidraw.mjs <content-directory>")
    process.exit(2)
  }
  await renderDrawings(directory)
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href)
  await main()
