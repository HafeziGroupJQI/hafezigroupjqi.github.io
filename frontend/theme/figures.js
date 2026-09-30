// Figures on a member's dark theme (quartz/styles/_figures.scss has the rules). A PNG or GIF the
// stylesheet can't place by its path (not a photo, not a plot the build made) is looked at here:
// drawn at 32×32 and counted, as Dark Reader does, and marked fig-light (drawn on white, or dark
// ink on nothing: matched to the page) or fig-keep. Every matched figure gets an "Original colors"
// button that shows it as drawn.
//
// analyzePixels is adapted from Dark Reader's analyzeImage (src/inject/dynamic-theme/image.ts,
// v4.9.133, https://github.com/darkreader/darkreader), under its license:
//
//   MIT License
//
//   Copyright (c) 2026 Dark Reader Ltd.
//
//   All rights reserved.
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.

/** Dark Reader's sample size: at most 32×32 pixels are counted. */
export const MAX_ANALYSIS_PIXELS_COUNT = 32 * 32
const TRANSPARENT_ALPHA_THRESHOLD = 0.05
const DARK_LIGHTNESS_THRESHOLD = 0.4
const LIGHT_LIGHTNESS_THRESHOLD = 0.7
const DARK_IMAGE_THRESHOLD = 0.7
const LIGHT_IMAGE_THRESHOLD = 0.7
const TRANSPARENT_IMAGE_THRESHOLD = 0.1

const lightness = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

/** Counts an RGBA pixel array (a canvas's ImageData.data) as Dark Reader's analyzeImage does. */
export function analyzePixels(data) {
  let transparent = 0
  let dark = 0
  let light = 0
  const total = data.length / 4
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] / 255 < TRANSPARENT_ALPHA_THRESHOLD) {
      transparent++
      continue
    }
    const l = lightness(data[i], data[i + 1], data[i + 2])
    if (l < DARK_LIGHTNESS_THRESHOLD) dark++
    if (l > LIGHT_LIGHTNESS_THRESHOLD) light++
  }
  const opaque = total - transparent
  return {
    isDark: opaque > 0 && dark / opaque >= DARK_IMAGE_THRESHOLD,
    isLight: opaque > 0 && light / opaque >= LIGHT_IMAGE_THRESHOLD,
    isTransparent: transparent / total >= TRANSPARENT_IMAGE_THRESHOLD,
  }
}

/**
 * Matched: a figure on a light background, or dark ink on a transparent one (it would vanish on a
 * dark page). Kept: photos and anything already dark.
 */
export const shouldMatch = ({ isLight, isDark, isTransparent }) =>
  isLight || (isTransparent && isDark)

/** Pictures the stylesheet leaves to this script: PNG and GIF, by their path. */
export const UNDECIDED = /\.(?:png|gif)(?:[?#]|$)/i

const VERDICTS = "hafezi.figures"

function remembered() {
  try {
    return JSON.parse(sessionStorage.getItem(VERDICTS) ?? "{}")
  } catch {
    return {}
  }
}

function remember(url, match) {
  try {
    sessionStorage.setItem(VERDICTS, JSON.stringify({ ...remembered(), [url]: match }))
  } catch {
    /* ignore */
  }
}

let canvas = null
/** Whether an image should be matched, or null when it can't be read (not loaded, other origin). */
function classify(img) {
  const width = img.naturalWidth
  const height = img.naturalHeight
  if (!width || !height) return null
  const k = Math.min(1, Math.sqrt(MAX_ANALYSIS_PIXELS_COUNT / (width * height)))
  const w = Math.ceil(width * k)
  const h = Math.ceil(height * k)
  canvas ??= Object.assign(document.createElement("canvas"), { width: 32, height: 32 })
  const context = canvas.getContext("2d", { willReadFrequently: true })
  try {
    context.clearRect(0, 0, 32, 32)
    context.drawImage(img, 0, 0, width, height, 0, 0, w, h)
    return shouldMatch(analyzePixels(context.getImageData(0, 0, w, h).data))
  } catch {
    return null
  }
}

const inverted = (img) => /invert/.test(getComputedStyle(img).filter)

function toggleFor(img) {
  const anchor = img.parentElement?.tagName === "A" ? img.parentElement : img
  let button = anchor.nextElementSibling
  if (!button?.classList.contains("fig-toggle")) {
    button = document.createElement("button")
    button.type = "button"
    button.className = "fig-toggle"
    button.addEventListener("click", () => {
      img.classList.toggle("fig-original")
      label(button, img)
    })
    anchor.after(button)
  }
  label(button, img)
  return button
}

function label(button, img) {
  const original = img.classList.contains("fig-original")
  button.textContent = original ? "Match the theme" : "Original colors"
  button.setAttribute("aria-pressed", String(original))
}

/** Marks undecided figures and puts an "Original colors" button under each matched one. */
export function updateFigures(root = document) {
  const on = document.documentElement.getAttribute("data-figures") === "match"
  const verdicts = remembered()
  for (const img of root.querySelectorAll(".page-body img")) {
    const src = img.currentSrc || img.src
    if (on && UNDECIDED.test(src) && !img.matches(".fig-light, .fig-keep")) {
      const decide = () => {
        const match = verdicts[src] ?? classify(img)
        if (match === null) return
        remember(src, match)
        img.classList.add(match ? "fig-light" : "fig-keep")
        updateFigures(root)
      }
      if (verdicts[src] !== undefined || img.complete) decide()
      else img.addEventListener("load", decide, { once: true })
    }
    const anchor = img.parentElement?.tagName === "A" ? img.parentElement : img
    const existing = anchor.nextElementSibling?.classList.contains("fig-toggle")
      ? anchor.nextElementSibling
      : null
    // Not loaded yet: looked at again once it is.
    if (on && !img.complete) {
      img.addEventListener("load", () => updateFigures(root), { once: true })
      continue
    }
    // Big enough to read (by its own size: an image off screen has none laid out), and changed by
    // the theme (or set back by the reader).
    const shown =
      on && img.naturalWidth >= 120 && (inverted(img) || img.classList.contains("fig-original"))
    if (shown) toggleFor(img)
    else existing?.remove()
  }
}

export function startFigures() {
  const run = () => updateFigures()
  if (document.readyState === "complete") run()
  else window.addEventListener("load", run, { once: true })
  document.addEventListener("themechange", run)
}
