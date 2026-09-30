import test from "node:test"
import assert from "node:assert"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import * as sass from "sass"
import yaml from "yaml"

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url))

test("paper's light theme is the site's (print.scss $light and quartz.config.yaml's lightMode)", () => {
  const css = sass.compile(here("./print.scss")).css
  const block = css.match(/:root:root\[saved-theme\] \{([^}]*)\}/)?.[1] ?? ""
  const printed = Object.fromEntries(
    [...block.matchAll(/--(\w+): ([^;]+);/g)].map(([, name, value]) => [
      name,
      value.replace(/\s*!important\s*$/, "").trim(),
    ]),
  )
  const config = yaml.parse(fs.readFileSync(here("../../quartz.config.yaml"), "utf8"))
  const light = config.configuration.theme.colors.lightMode as Record<string, string>
  assert.deepStrictEqual(printed, light)
})

test("the print layer comes last in the site's stylesheet, so it wins its ties", () => {
  const custom = fs.readFileSync(here("./custom.scss"), "utf8").trimEnd()
  assert.ok(custom.endsWith('@include meta.load-css("print");'))
  assert.doesNotMatch(custom, /@media print/)
})
