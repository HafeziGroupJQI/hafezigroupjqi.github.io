import assert from "node:assert/strict"
import test from "node:test"
import LZString from "lz-string"
import { drawingAliases, drawingOutputPath, parseDrawing, rewriteDrawingEmbeds } from "./render-excalidraw.mjs"

const scene = { type: "excalidraw", elements: [{ type: "rectangle", id: "box", x: 0, y: 0, width: 100, height: 50 }], files: {} }

test("compressed Obsidian drawings decode and receive stable output paths", () => {
  const source = `---\ntags: [excalidraw]\n---\n\n\`\`\`compressed-json\n${LZString.compressToBase64(JSON.stringify(scene))}\n\`\`\``
  assert.deepEqual(parseDrawing("drawing.excalidraw.md", source).elements, scene.elements)
  assert.equal(drawingOutputPath("/vault", "/vault/notes/drawing.excalidraw.md"), "/vault/assets/excalidraw/notes/drawing.svg")
})

test("drawing embeds become static images with interactive links", () => {
  const filename = "/vault/notes/drawing.excalidraw.md"
  const drawings = [{
    aliases: drawingAliases("/vault", filename),
    outputRelative: "assets/excalidraw/notes/drawing.svg",
    pageRelative: "notes/drawing.excalidraw",
    title: "Drawing",
  }]
  assert.equal(
    rewriteDrawingEmbeds("![[notes/drawing.excalidraw]]", drawings),
    "![[assets/excalidraw/notes/drawing.svg|Drawing]]\n\n[[notes/drawing.excalidraw|Open interactive drawing]]",
  )
})
