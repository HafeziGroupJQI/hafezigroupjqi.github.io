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

// Rendering needs the headless Chromium that npm run setup:browser installs.
const hasBrowser = () =>
  chromium.launch().then(
    (browser) => browser.close().then(() => true),
    () => false,
  )

const renderScene = async (t, elements, pages = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "render-excalidraw-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, "box.excalidraw"), JSON.stringify({ ...scene, elements }))
  for (const [name, text] of Object.entries(pages)) fs.writeFileSync(path.join(root, name), text)
  const [drawing] = await renderDrawings(root)
  return { root, drawing, svg: fs.readFileSync(path.join(root, drawing.outputRelative), "utf8") }
}

test("drawings render offline to SVGs with Virgil inlined, and embeds point at them", async (t) => {
  if (!(await hasBrowser())) return t.skip("no headless Chromium (npm run setup:browser)")
  const label = {
    type: "text",
    id: "label",
    x: 10,
    y: 10,
    text: "Hello",
    fontSize: 20,
    fontFamily: 1,
  }
  const { root, drawing, svg } = await renderScene(t, [...scene.elements, label], {
    "page.md": "![[box.excalidraw]]\n",
  })
  assert.equal(drawing.outputRelative, "assets/excalidraw/box.svg")
  assert.match(svg, /^<svg [^>]*viewBox="0 0 [\d.]+ [\d.]+"/)
  assert.match(svg, /@font-face \{ font-family: Virgil; src: url\(data:font\/woff2;base64,/)
  assert.match(svg, /<text [^>]*font-family="Virgil, Segoe UI Emoji"[^>]*>Hello<\/text>/)
  assert.equal(
    fs.readFileSync(path.join(root, "page.md"), "utf8"),
    "![box](assets/excalidraw/box.svg)\n\n[Open interactive drawing](box.excalidraw)\n",
  )
})

test("a stored label bound to its box is drawn where it was authored", async (t) => {
  if (!(await hasBrowser())) return t.skip("no headless Chromium (npm run setup:browser)")
  const box = {
    ...scene.elements[0],
    width: 200,
    height: 100,
    boundElements: [{ type: "text", id: "label" }],
  }
  const label = {
    type: "text",
    id: "label",
    x: 75,
    y: 37.5,
    width: 50,
    height: 25,
    text: "Hi",
    originalText: "Hi",
    fontSize: 20,
    fontFamily: 1,
    lineHeight: 1.25,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: "box",
  }
  const { svg } = await renderScene(t, [box, label])
  // with the 20px export margin: the box at (20, 20) and its label centred inside it
  assert.match(svg, /transform="translate\(20 20\) rotate\(0 100 50\)"/)
  assert.match(svg, /<g transform="translate\(95 57\.5\) rotate\(0 25 12\.5\)"><text x="25" /)
})
