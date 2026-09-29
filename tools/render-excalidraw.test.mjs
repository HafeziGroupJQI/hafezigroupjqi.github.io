import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import LZString from "lz-string"
import { chromium } from "playwright-core"
import {
  drawingAliases,
  drawingOutputPath,
  parseDrawing,
  renderDrawings,
  rewriteDrawingEmbeds,
} from "./render-excalidraw.mjs"

const scene = {
  type: "excalidraw",
  elements: [{ type: "rectangle", id: "box", x: 0, y: 0, width: 100, height: 50 }],
  files: {},
}

test("compressed Obsidian drawings decode and receive stable output paths", () => {
  const source = `---\ntags: [excalidraw]\n---\n\n\`\`\`compressed-json\n${LZString.compressToBase64(JSON.stringify(scene))}\n\`\`\``
  assert.deepEqual(parseDrawing("drawing.excalidraw.md", source).elements, scene.elements)
  assert.equal(
    drawingOutputPath("/vault", "/vault/notes/drawing.excalidraw.md"),
    "/vault/assets/excalidraw/notes/drawing.svg",
  )
})

test("drawing embeds become static images with interactive links", () => {
  const filename = "/vault/notes/drawing.excalidraw.md"
  const drawings = [
    {
      aliases: drawingAliases("/vault", filename),
      outputRelative: "assets/excalidraw/notes/drawing.svg",
      pageRelative: "notes/drawing.excalidraw",
      title: "Drawing",
    },
  ]
  assert.equal(
    rewriteDrawingEmbeds("![[notes/drawing.excalidraw]]", drawings, "journal/source.md"),
    "![Drawing](../assets/excalidraw/notes/drawing.svg)\n\n[Open interactive drawing](../notes/drawing.excalidraw)",
  )
})

test("drawings render offline to SVGs with Virgil inlined, and embeds point at them", async (t) => {
  const browser = await chromium.launch().catch(() => null)
  if (!browser) return t.skip("no headless Chromium (npm run setup:browser)")
  await browser.close()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "render-excalidraw-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const label = { type: "text", id: "label", x: 10, y: 10, text: "Hello", fontSize: 20 }
  fs.writeFileSync(
    path.join(root, "box.excalidraw"),
    JSON.stringify({ ...scene, elements: [...scene.elements, label] }),
  )
  fs.writeFileSync(path.join(root, "page.md"), "![[box.excalidraw]]\n")

  const [drawing] = await renderDrawings(root)
  assert.equal(drawing.outputRelative, "assets/excalidraw/box.svg")
  const svg = fs.readFileSync(path.join(root, drawing.outputRelative), "utf8")
  assert.match(svg, /^<svg [^>]*viewBox="0 0 [\d.]+ [\d.]+"/)
  assert.match(svg, /@font-face \{ font-family: Virgil; src: url\(data:font\/woff2;base64,/)
  assert.match(svg, /<text [^>]*font-family="Virgil, Segoe UI Emoji"[^>]*>Hello<\/text>/)
  assert.equal(
    fs.readFileSync(path.join(root, "page.md"), "utf8"),
    "![box](assets/excalidraw/box.svg)\n\n[Open interactive drawing](box.excalidraw)\n",
  )
})
