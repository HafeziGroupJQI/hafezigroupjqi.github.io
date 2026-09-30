import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { THEMES_FILE, themeData, writeThemes } from "./build.mjs"

test("the theme data is written with a version that follows its content", (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "themes-"))
  t.after(() => fs.rmSync(out, { recursive: true, force: true }))
  const v = writeThemes(out)
  assert.match(v, /^[0-9a-f]{12}$/)
  const written = JSON.parse(fs.readFileSync(path.join(out, THEMES_FILE), "utf8"))
  assert.equal(written.v, v)
  assert.equal(themeData().v, v)
  assert.equal(written.themes[0].id, "default")
  assert.equal(written.themes[1].id, "default-dark")
  for (const theme of written.themes) {
    assert.deepEqual(Object.keys(theme), [
      "id",
      "name",
      "family",
      "polarity",
      "vars",
      "base",
      "swatch",
    ])
    assert.equal(Object.keys(theme.base).length, 16)
  }
  // Small enough to fetch on /settings and at sign-in.
  assert.ok(fs.statSync(path.join(out, THEMES_FILE)).size < 250_000)
})
