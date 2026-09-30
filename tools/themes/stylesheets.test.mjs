// Every color in the site's stylesheets goes through a color token (frontend/theme/tokens.js), so a
// member's theme reaches it; and the default theme, which sets no token, renders exactly as the
// stylesheet was written. A color added without a token fails here: write it as
// `var(--c-rule, #ddd)` (the token for its job, with the color as today's fallback).
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import yaml from "yaml"
import { QUARTZ, TOKENS } from "../../frontend/theme/tokens.js"

const repo = (name) => fileURLToPath(new URL(`../../${name}`, import.meta.url))
const SHEETS = [
  "quartz/styles/_jqi-theme.scss",
  "quartz/styles/custom.scss",
  "quartz/styles/callouts.scss",
  "quartz/styles/_page-editor.scss",
  "quartz/styles/base.scss",
  "quartz/styles/syntax.scss",
  "quartz/components/styles/popover.scss",
]
// Stylesheets that define colors of their own on purpose: paper (print.scss) is always light.
const EXEMPT = ["quartz/styles/print.scss", "quartz/styles/variables.scss"]

// Families of local variables that are themselves defined from tokens.
const LOCAL = /^--(?:jqi|gpt|dash|wl|viz|fc|d2h)-[\w-]+$/

const COLOR =
  /#[0-9a-fA-F]{3,8}\b|(?:rgb|hsl)a?\((?:[^()]|\([^()]*\))*\)|(?<![\w-])(?:white|black)(?![\w-])/g

const channels = (color) => {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex
    const [r, g, b, a = 255] = full.match(/../g).map((pair) => parseInt(pair, 16))
    return { r, g, b, a: a / 255 }
  }
  const parts = color.match(/[\d.]+%?/g)?.map((part) => parseFloat(part)) ?? []
  const [r, g, b, a = 1] = parts
  return { r, g, b, a: /%\)$/.test(color) && parts.length === 4 ? a / 100 : a }
}

/** A see-through gray or black is a shadow or a scrim, the same on every theme. */
const neutralTranslucent = (color) => {
  const { r, g, b, a } = channels(color)
  return a < 1 && r === g && g === b
}

const normalize = (color) => {
  const { r, g, b, a } = channels(color)
  return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`
}

/** Each color outside a token's fallback, with its line. */
function stray(file) {
  const found = []
  fs.readFileSync(repo(file), "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (/\/\/ fixed: \S/.test(line)) return
      const code = line.replace(/\/\/.*$/, "").replace(/url\((?:[^()]|\([^()]*\))*\)/g, "url()")
      // A declaration of a local chart palette (--viz-*) or of Tailwind's internals.
      if (/^\s*--viz-[\w-]+\s*:/.test(code)) return
      for (const match of code.matchAll(COLOR)) {
        const before = code.slice(0, match.index)
        if (/var\(\s*--[\w-]+\s*,\s*(?:[\w-]+\(\s*[^()]*)?$/.test(before)) continue
        if (neutralTranslucent(match[0])) continue
        if (
          /(?:^|[;{])\s*(?:--tw-[\w-]+|box-shadow|text-shadow|mask[\w-]*)\s*:[^;{}]*$/.test(before)
        )
          continue
        found.push({ file, line: index + 1, color: match[0], text: line.trim().slice(0, 100) })
      }
    })
  return found
}

test("every color in the site's stylesheets is a token's fallback", () => {
  assert.deepEqual(
    SHEETS.flatMap(stray).map(
      ({ file, line, color, text }) => `${file}:${line}: ${color} in ${text}`,
    ),
    [],
  )
})

test("a token's fallback is a color the default theme really has", () => {
  const light = yaml.parse(fs.readFileSync(repo("quartz.config.yaml"), "utf8")).configuration.theme
    .colors.lightMode
  const problems = []
  for (const file of SHEETS)
    for (const match of fs
      .readFileSync(repo(file), "utf8")
      .matchAll(/var\(\s*(--[\w-]+)\s*,\s*((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g)) {
      const [, token, fallback] = match
      if (!fallback.match(COLOR)) continue
      if (TOKENS.includes(token)) {
        // Quartz's nine are always defined, so their fallback must be what they are defined as.
        const name = token.slice(2)
        if (QUARTZ.includes(token) && normalize(fallback.trim()) !== normalize(light[name]))
          problems.push(`${file}: ${token} is ${light[name]}, not ${fallback}`)
      } else if (!LOCAL.test(token) && !/^--(?:tw|shiki|print)-/.test(token))
        problems.push(`${file}: var(${token}) is not a color token`)
    }
  assert.deepEqual(problems, [])
})

test("no stylesheet defines a theme's own tokens: only a member's theme sets them", () => {
  const themed = TOKENS.filter((token) => !QUARTZ.includes(token))
  const defined = []
  for (const file of [...SHEETS, ...EXEMPT]) {
    const text = fs.readFileSync(repo(file), "utf8")
    for (const token of themed)
      if (new RegExp(`(?:^|[;{\\s])${token}\\s*:`).test(text)) defined.push(`${file}: ${token}`)
  }
  assert.deepEqual(defined, [])
})

test("the check notices a bare color, and passes a fallback, a shadow and a marked exception", () => {
  const sample = [
    ".a { color: #123456; }",
    ".b { border: 1px solid var(--c-rule, #ddd); }",
    ".c { box-shadow: 0 4px 12px #0002; }",
    ".d { color: #fff; } // fixed: white over a photo",
    ".e { background: var(--c-warn-soft, color-mix(in srgb, #eda100 12%, transparent)); }",
    ".f { background: rgba(70, 70, 70, 0.08); color: white; }",
  ].join("\n")
  const file = "tools/themes/.stylesheets-sample.scss"
  fs.writeFileSync(repo(file), sample)
  try {
    assert.deepEqual(
      stray(file).map(({ line, color }) => [line, color]),
      [
        [1, "#123456"],
        [6, "white"],
      ],
    )
  } finally {
    fs.rmSync(repo(file))
  }
})
