import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import * as sass from "sass"
import { QUARTZ, TOKENS } from "../../frontend/theme/tokens.js"

const here = (name) => fileURLToPath(new URL(name, import.meta.url))

test("paper resets every token a member's theme sets, over the theme's inline values", () => {
  const css = sass.compile(here("../../quartz/styles/print.scss")).css
  const block = css.match(/:root:root\[saved-theme\] \{([^}]*)\}/)?.[1] ?? ""
  const reset = Object.fromEntries(
    [...block.matchAll(/(--[\w-]+): ([^;]+);/g)].map(([, name, value]) => [name, value.trim()]),
  )
  assert.deepEqual(Object.keys(reset).sort(), [...TOKENS].sort())
  for (const [token, value] of Object.entries(reset)) {
    assert.match(value, /!important$/, token)
    if (!QUARTZ.includes(token)) assert.equal(value, "initial !important", token)
  }
})

test("what only a theme needs on screen never reaches paper", () => {
  const css = sass.compile(here("../../quartz/styles/_themes.scss")).css
  // Everything in the file sits inside @media screen.
  assert.equal(css.replace(/@media screen \{[\s\S]*\}\s*$/, "").trim(), "")
})
