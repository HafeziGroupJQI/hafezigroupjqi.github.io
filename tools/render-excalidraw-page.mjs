// The page tools/render-excalidraw.mjs bundles and loads in headless Chromium. It exports one
// stored drawing to an SVG string as authored, with a 20px margin on white and the fonts inlined.
import { exportToSvg } from "@excalidraw/excalidraw"

const EXPORT_PADDING = 20

export async function renderDrawing(elements, files) {
  const svg = await exportToSvg({
    elements,
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
