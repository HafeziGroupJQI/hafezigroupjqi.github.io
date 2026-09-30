import test from "node:test"
import assert from "node:assert/strict"
import { UNDECIDED, analyzePixels, shouldMatch } from "./figures.js"

/** A 32×32 RGBA image from a function of (x, y) → [r, g, b, a]. */
function image(pixel) {
  const data = new Uint8ClampedArray(32 * 32 * 4)
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) data.set(pixel(x, y), 4 * (y * 32 + x))
  return data
}
const verdict = (pixel) => shouldMatch(analyzePixels(image(pixel)))

test("a line plot on white is matched to a dark page", () => {
  // White, with a dark axis and a blue curve.
  const plot = (x, y) =>
    x === 3 || y === 28
      ? [20, 20, 20, 255]
      : Math.abs(y - (28 - x * 0.8)) < 1
        ? [31, 119, 180, 255]
        : [255, 255, 255, 255]
  assert.equal(verdict(plot), true)
})

test("black ink on a transparent background is matched, or it would vanish", () => {
  const ink = (x, y) => ((x + y) % 5 === 0 ? [0, 0, 0, 255] : [0, 0, 0, 0])
  assert.equal(verdict(ink), true)
})

test("a photo keeps its colors", () => {
  // Mid tones everywhere: sky, skin, foliage.
  const photo = (x, y) => [
    90 + ((x * 7 + y * 3) % 90),
    80 + ((x * 3 + y * 11) % 80),
    60 + ((x * 5) % 70),
    255,
  ]
  assert.equal(verdict(photo), false)
})

test("a plot already on a dark background keeps its colors", () => {
  const dark = (x, y) => (Math.abs(y - x) < 1 ? [250, 200, 60, 255] : [18, 18, 24, 255])
  assert.equal(verdict(dark), false)
})

test("counting follows Dark Reader's thresholds", () => {
  assert.deepEqual(analyzePixels(image(() => [255, 255, 255, 255])), {
    isDark: false,
    isLight: true,
    isTransparent: false,
  })
  assert.deepEqual(analyzePixels(image(() => [0, 0, 0, 0])), {
    isDark: false,
    isLight: false,
    isTransparent: true,
  })
})

test("only PNG and GIF are left to the script", () => {
  assert.ok(UNDECIDED.test("/a/plot.png"))
  assert.ok(UNDECIDED.test("/a/anim.GIF?raw"))
  assert.ok(UNDECIDED.test("/a/plot.png#caption"))
  assert.ok(!UNDECIDED.test("/assets/people/ada.jpg"))
  assert.ok(!UNDECIDED.test("/a/drawing.svg"))
})
