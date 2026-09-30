import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { TOKENS, SYNTAX, DEFAULT_DARK, DEFAULT_LIGHT } from "../../frontend/theme/tokens.js"
import { contrast, mapScheme, mix, repair } from "./map.mjs"
import { CURATED, HAFEZI_DARK } from "./overrides.mjs"
import { loadThemes } from "./themes.mjs"

const themes = loadThemes()
const named = themes.filter((theme) => theme.vars)
const byId = Object.fromEntries(themes.map((theme) => [theme.id, theme]))

const mocha = {
  id: "plain-mocha",
  name: "Mocha",
  palette: {
    ...{ base00: "#1e1e2e", base01: "#181825", base02: "#313244", base03: "#45475a" },
    ...{ base04: "#585b70", base05: "#cdd6f4", base06: "#f5e0dc", base07: "#b4befe" },
    ...{ base08: "#f38ba8", base09: "#fab387", base0A: "#f9e2af", base0B: "#a6e3a1" },
    ...{ base0C: "#94e2d5", base0D: "#89b4fa", base0E: "#cba6f7", base0F: "#f2cdcd" },
  },
}

test("a scheme's slots land on the roles base16 gives them", () => {
  const { vars, polarity, base } = mapScheme(mocha)
  assert.equal(polarity, "dark")
  assert.equal(vars["--light"], "#1e1e2e")
  assert.equal(vars["--c-surface-1"], "#181825")
  assert.equal(vars["--c-surface-2"], "#313244")
  assert.equal(vars["--darkgray"], "#cdd6f4")
  // Rosewater (base06) is an accent there, not a brighter foreground: headings keep the text's color.
  assert.equal(vars["--dark"], "#cdd6f4")
  assert.equal(vars["--secondary"], "#f38ba8")
  assert.equal(vars["--c-ok"], "#a6e3a1")
  assert.equal(vars["--c-info"], "#89b4fa")
  assert.equal(vars["--syn-keyword"], "#cba6f7")
  assert.equal(vars["--syn-string"], "#a6e3a1")
  assert.equal(vars["--fig-filter"], "invert(1) hue-rotate(180deg)")
  assert.equal(base.base00, "#1e1e2e")
  assert.equal(base.base0D, "#89b4fa")
  assert.deepEqual(Object.keys(vars), TOKENS)
})

test("a status color is found by its hue where a scheme's slot holds another", () => {
  // GitHub Light's base08 is brown and its red is base0E; Rosé Pine has no green, so "ok" is its pine.
  const red = byId.github.vars["--secondary"]
  assert.ok(contrast(red, "#cf222e") < 1.2, red)
  assert.ok(contrast(red, "#953800") > 1.2, red)
  assert.equal(contrast(byId["rose-pine-moon"].vars["--c-ok"], "#232136") >= 4.5, true)
})

test("repair reaches its target, moves no color that already has it, and is idempotent", () => {
  assert.equal(repair("#cdd6f4", ["#1e1e2e"], 4.5), "#cdd6f4")
  const lifted = repair("#e21833", ["#161618", "#1d1d21"], 4.5)
  assert.notEqual(lifted, "#e21833")
  assert.ok(contrast(lifted, "#1d1d21") >= 4.5)
  assert.equal(repair(lifted, ["#161618", "#1d1d21"], 4.5), lifted)
  // Toward black on a light ground.
  const lowered = repair("#268bd2", ["#fdf6e3"], 4.5)
  assert.ok(contrast(lowered, "#fdf6e3") >= 4.5)
  assert.ok(contrast(lowered, "#000000") < contrast("#268bd2", "#000000"))
  for (const theme of named)
    for (const token of ["--darkgray", "--gray", "--secondary"])
      assert.equal(
        repair(theme.vars[token], [theme.vars["--light"], theme.vars["--c-surface-1"]], 4.5),
        theme.vars[token],
        `${theme.id} ${token}`,
      )
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080")
})

test("a mapped theme maps to itself: the colors sent to the lab need no second repair", () => {
  for (const theme of named) {
    const again = mapScheme({ id: theme.id, name: theme.name, palette: theme.base })
    for (const token of ["--light", "--darkgray", ...SYNTAX.slice(1)])
      assert.equal(again.vars[token], theme.vars[token], `${theme.id} ${token}`)
  }
})

test("every shipped theme passes WCAG AA for its text, links, accent, status and code colors", () => {
  assert.ok(named.length >= 100)
  for (const theme of named) {
    const v = theme.vars
    const on = (ground) => (token, target) =>
      assert.ok(
        contrast(v[token], ground) >= target,
        `${theme.id}: ${token} ${v[token]} on ${ground} is ${contrast(v[token], ground).toFixed(2)}, under ${target}`,
      )
    for (const ground of [v["--light"], v["--c-surface-1"]]) {
      const check = on(ground)
      for (const token of ["--darkgray", "--dark", "--c-strong", "--gray", "--c-muted"])
        check(token, 4.5)
      for (const token of ["--secondary", "--tertiary", "--c-ok", "--c-warn", "--c-err"])
        check(token, 4.5)
      check("--c-info", 4.5)
      check("--c-focus", 3)
      check("--syn-comment", 3)
      for (const token of SYNTAX.slice(1)) check(token, 4.5)
    }
    // Hovered and selected items.
    for (const token of ["--darkgray", "--dark", "--gray", "--secondary"])
      on(v["--c-surface-2"])(token, 3)
    // Text on tints, and each status color on its own tint.
    for (const name of ["accent", "ok", "warn", "err", "info"])
      for (const tint of [v[`--c-${name}-soft`], v[`--c-${name}-softer`]]) {
        on(tint)("--darkgray", 4.5)
        on(tint)(name === "accent" ? "--secondary" : `--c-${name}`, 4.5)
      }
    // Bands, and fills of the accent and the status colors.
    on(v["--c-band"])("--c-on-band", 4.5)
    for (const fill of ["--secondary", "--c-ok", "--c-warn", "--c-err", "--c-info"])
      on(v[fill])("--c-on-accent", 4.5)
    // Borders can be seen.
    assert.ok(contrast(v["--lightgray"], v["--light"]) >= 1.2, `${theme.id}: rule`)
  }
})

test("polarity is read from the background, and figures are matched accordingly", () => {
  for (const theme of named) {
    const dark =
      contrast(theme.vars["--light"], "#ffffff") > contrast(theme.vars["--light"], "#000000")
    assert.equal(theme.polarity, dark ? "dark" : "light", theme.id)
    assert.equal(theme.vars["--fig-filter"].includes("invert"), dark, theme.id)
    assert.equal(
      theme.vars["--fig-blend"],
      dark ? "screen" : theme.vars["--light"] === "#ffffff" ? "normal" : "multiply",
    )
  }
  assert.equal(byId["catppuccin-latte"].polarity, "light")
  assert.equal(byId.nord.polarity, "dark")
})

test("the list: both Hafezi themes first, the curated families, then the rest", () => {
  assert.equal(themes[0].id, DEFAULT_LIGHT)
  assert.equal(themes[0].vars, null)
  assert.equal(themes[1].id, DEFAULT_DARK)
  assert.equal(themes[1].name, "Hafezi Dark")
  assert.equal(themes[1].vars["--light"], HAFEZI_DARK.palette.base00)
  assert.deepEqual(
    themes.slice(2, 2 + CURATED.length).map((theme) => theme.name),
    CURATED.map(([, name]) => name),
  )
  for (const id of ["catppuccin-mocha", "rose-pine-moon", "nord", "dracula", "gruvbox-dark-medium"])
    assert.ok(byId[id], id)
  for (const theme of themes) assert.match(theme.id, /^[a-z0-9][a-z0-9-]{0,63}$/)
  assert.ok(themes.slice(2 + CURATED.length).every((theme) => theme.family === "More themes"))
})

test("Catppuccin and Rosé Pine take their text tiers from the projects' own palettes", () => {
  assert.equal(byId["catppuccin-mocha"].vars["--gray"], "#a6adc8") // subtext0
  assert.equal(byId["catppuccin-mocha"].vars["--c-band"], "#11111b") // crust
  // subtle, which is a hair under 4.5 on Moon's surface
  assert.equal(byId["rose-pine-moon"].vars["--gray"], repair("#908caa", ["#2a273f"], 4.5))
  assert.equal(byId["rose-pine"].vars["--gray"], "#908caa")
})

test("the scheme files are tinted-theming's, with their license beside them", () => {
  const license = fs.readFileSync(
    fileURLToPath(new URL("./schemes/LICENSE", import.meta.url)),
    "utf8",
  )
  assert.match(license, /Tinted Theming/)
  assert.match(license, /Permission is hereby granted, free of charge/)
})
