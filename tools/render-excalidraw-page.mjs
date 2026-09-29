// The page tools/render-excalidraw.mjs bundles and loads in headless Chromium. It exports one
// drawing to an SVG string: labels default to centred, text is drawn in Virgil, and the export
// has a 20px margin on white with the fonts inlined.
import { convertToExcalidrawElements, exportToSvg } from "@excalidraw/excalidraw"

const EXPORT_PADDING = 20

// Converting measures text on a canvas, and centred text is placed by its width: without Virgil
// loaded the widths would come from Chromium's default serif font.
const virgil = new FontFace(
  "Virgil",
  `url(${window.EXCALIDRAW_ASSET_PATH}fonts/Virgil/Virgil-Regular.woff2)`,
)
document.fonts.add(virgil)
await virgil.load()

export async function renderDrawing(elements, files) {
  const withLabelDefaults = elements.map((element) =>
    element.label
      ? { ...element, label: { textAlign: "center", verticalAlign: "middle", ...element.label } }
      : element,
  )
  const scene = convertToExcalidrawElements(withLabelDefaults, { regenerateIds: false }).map(
    (element) => (element.type === "text" ? { ...element, fontFamily: 1 } : element),
  )
  const svg = await exportToSvg({
    elements: scene,
    appState: { viewBackgroundColor: "#ffffff", exportBackground: true },
    files,
    exportPadding: EXPORT_PADDING,
    skipInliningFonts: false,
  })
  const width = parseInt(svg.getAttribute("width") || "800")
  const height = parseInt(svg.getAttribute("height") || "600")
  svg.setAttribute("width", String(width))
  svg.setAttribute("height", String(height))
  svg.style.width = `${width}px`
  svg.style.height = `${height}px`
  return new XMLSerializer().serializeToString(svg)
}
