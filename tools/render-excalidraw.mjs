import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import LZString from "lz-string"
import yaml from "yaml"

const rendererEntry = fileURLToPath(new URL("./index.js", import.meta.resolve("excalidraw-render")))

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
    const decoded = block[1] === "compressed-json"
      ? LZString.decompressFromBase64(block[2].replace(/\s/g, ""))
      : block[2]
    if (!decoded) throw new Error(`${filename}: compressed Excalidraw data could not be decoded`)
    scene = JSON.parse(decoded)
  }
  const elements = Array.isArray(scene) ? scene : scene.elements
  if (!Array.isArray(elements) || elements.length === 0) throw new Error(`${filename}: drawing has no elements`)
  const files = Object.fromEntries(
    Object.entries(scene.files ?? {}).map(([id, file]) => [id, { mimeType: file.mimeType, dataURL: file.dataURL }]),
  )
  for (const element of elements.filter((candidate) => candidate.type === "image")) {
    if (!element.fileId || !files[element.fileId]) throw new Error(`${filename}: missing embedded file ${element.fileId ?? "(unset)"}`)
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
  const frontmatter = match ? yaml.parse(match[1]) ?? {} : {}
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

export function rewriteDrawingEmbeds(text, drawings) {
  return text.replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g, (match, raw) => {
    const target = raw.trim().replace(/\\$/, "")
    const candidates = drawings.filter((drawing) => drawing.aliases.has(target) || drawing.aliases.has(path.basename(target)))
    if (candidates.length === 0) return match
    if (candidates.length > 1) throw new Error(`ambiguous Excalidraw embed [[${raw}]]`)
    const drawing = candidates[0]
    return `![[${drawing.outputRelative}|${drawing.title}]]\n\n[[${drawing.pageRelative}|Open interactive drawing]]`
  })
}

const sanitizeSvg = (filename) => {
  const svg = fs.readFileSync(filename, "utf8")
  if (!/<svg\b/i.test(svg) || !/viewBox=/i.test(svg)) throw new Error(`${filename}: renderer produced an invalid SVG`)
  if (/<script\b|\son[a-z]+\s*=|(?:href|src)=["']https?:/i.test(svg)) throw new Error(`${filename}: renderer produced unsafe external content`)
}

export async function renderDrawings(rootDirectory) {
  const root = fs.realpathSync(rootDirectory)
  const filenames = walk(root).filter((filename) => drawingPattern.test(filename))
  if (filenames.length === 0) {
    console.log("render-excalidraw: no drawings")
    return []
  }

  const client = new Client({ name: "hafezi-site-build", version: "1.0.0" })
  const transport = new StdioClientTransport({ command: process.execPath, args: [rendererEntry], stderr: "inherit" })
  await client.connect(transport)
  const drawings = []
  try {
    for (const filename of filenames) {
      const scene = parseDrawing(filename)
      const output = drawingOutputPath(root, filename)
      fs.mkdirSync(path.dirname(output), { recursive: true })
      const result = await client.callTool({
        name: "create_excalidraw_diagram",
        arguments: {
          elements: JSON.stringify(scene.elements),
          files: Object.keys(scene.files).length ? scene.files : undefined,
          outputPath: output,
          format: "svg",
        },
      })
      if (result.isError) throw new Error(result.content.map((item) => item.type === "text" ? item.text : "render error").join("\n"))
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
    await client.close()
  }

  for (const page of walk(root).filter((filename) => pagePattern.test(filename) && !drawingPattern.test(filename))) {
    const before = fs.readFileSync(page, "utf8")
    const after = rewriteDrawingEmbeds(before, drawings)
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

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) await main()
