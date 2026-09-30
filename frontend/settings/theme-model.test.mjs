import test from "node:test"
import assert from "node:assert/strict"
import { themeData } from "../../tools/themes/build.mjs"
import { MODES, MORE, groups, matches, slotThemes, summary } from "./theme-model.js"

const { themes } = themeData()

test("each picker offers the themes of its kind, the site's own first and the long tail last", () => {
  const light = slotThemes(themes, "light")
  const dark = slotThemes(themes, "dark")
  assert.equal(light[0].name, "Hafezi Light")
  assert.equal(dark[0].name, "Hafezi Dark")
  assert.ok(light.every((theme) => theme.polarity === "light"))
  assert.ok(dark.some((theme) => theme.id === "catppuccin-mocha"))
  const families = groups(dark).map((group) => group.family)
  assert.equal(families[0], "Hafezi")
  assert.equal(families.at(-1), MORE)
  assert.ok(families.includes("Catppuccin") && families.includes("Rosé Pine"))
  assert.equal(new Set(families).size, families.length)
})

test("search finds a theme by name or family, without caring about case or accents", () => {
  const found = (query) => themes.filter((theme) => matches(theme, query)).map((theme) => theme.id)
  assert.deepEqual(found("rose moon"), ["rose-pine-moon"])
  assert.ok(found("CATPPUCCIN").includes("catppuccin-latte"))
  assert.ok(found("").length === themes.length)
})

test("the dark mode switch reads Off, On, Match my device", () => {
  assert.deepEqual(
    MODES.map(([, label]) => label),
    ["Off", "On", "Match my device"],
  )
})

test("the summary says, in plain words, what the member sees", () => {
  const prefs = { mode: "light", light: "default", dark: "catppuccin-mocha", figures: true }
  assert.equal(summary(prefs, themes), "Dark mode is off: you see Hafezi Light.")
  assert.equal(
    summary({ ...prefs, mode: "dark" }, themes),
    "Dark mode is on: you see Catppuccin Mocha.",
  )
  assert.match(
    summary({ ...prefs, mode: "system" }, themes),
    /Catppuccin Mocha when it is in dark mode/,
  )
})
