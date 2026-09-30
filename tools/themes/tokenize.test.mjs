import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { detokenize, tokenize } from "./tokenize.mjs"

const vendored = fs.readFileSync(
  fileURLToPath(new URL("../../quartz/styles/_jqi-theme.scss", import.meta.url)),
  "utf8",
)

test("each color takes the token its property gives it", () => {
  assert.equal(
    tokenize(".a{background-color:#fff;color:#222;border-bottom:1px solid #e6e6e6}"),
    ".a{background-color:var(--light,#fff);color:var(--dark,#222);border-bottom:1px solid var(--lightgray,#e6e6e6)}",
  )
  // One color, two jobs: #fff is text on a dark band, and on the accent it is the accent's text.
  assert.equal(
    tokenize(".b{background-color:#454545;color:#fff}.c{background-color:#e21833;color:#fff}"),
    ".b{background-color:var(--c-band,#454545);color:var(--c-on-band,#fff)}.c{background-color:var(--secondary,#e21833);color:var(--c-on-accent,#fff)}",
  )
  assert.equal(
    tokenize("@media (min-width:800px){.d{color:#e21833!important}}"),
    "@media (min-width:800px){.d{color:var(--secondary,#e21833)!important}}",
  )
})

test("shadows, Tailwind's variables, strings and fonts are left alone", () => {
  const fixed =
    '.e{box-shadow:0 2px 4px rgba(70,70,70,.08);--tw-ring-color:rgba(59,130,246,.5);content:"#fff;"}' +
    '@font-face{src:url(static/theme/fonts/a.woff2#fff) format("woff2")}'
  assert.equal(tokenize(fixed), fixed)
})

test("a color no rule names is reported, not guessed", () => {
  const unknown = []
  const css = ".f{color:#123456}"
  assert.equal(
    tokenize(css, { unknown: (color, property) => unknown.push([color, property]) }),
    css,
  )
  assert.deepEqual(unknown, [["#123456", "color"]])
})

test("the vendored stylesheet is tokenized: complete, idempotent, and exactly undone", () => {
  const plain = detokenize(vendored)
  assert.notEqual(plain, vendored)
  const unknown = []
  assert.equal(tokenize(plain, { unknown: (color) => unknown.push(color) }), vendored)
  assert.deepEqual(unknown, [])
  assert.equal(tokenize(vendored), vendored)
  // Only color tokens are undone; Tailwind's own var(--tw-…,1) stays.
  assert.equal(
    detokenize("a{b:var(--tw-bg-opacity,1);c:var(--light,#fff)}"),
    "a{b:var(--tw-bg-opacity,1);c:#fff}",
  )
})
