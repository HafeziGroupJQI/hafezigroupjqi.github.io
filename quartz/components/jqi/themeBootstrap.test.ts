import test from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { THEME_KEY, themeBootstrap } from "./themeBootstrap"

const MOCHA = {
  id: "catppuccin-mocha",
  polarity: "dark",
  vars: { "--light": "#1e1e2e", "--darkgray": "#cdd6f4", "--fig-filter": "invert(1)" },
}
const LATTE = { id: "catppuccin-latte", polarity: "light", vars: { "--light": "#eff1f5" } }

/** Runs the bootstrap in a page with this localStorage and device setting; returns <html>'s state. */
function run(storage: Record<string, string>, deviceDark = false) {
  const attributes: Record<string, string> = {}
  const style: Record<string, string> = {}
  const documentElement = {
    setAttribute: (name: string, value: string) => (attributes[name] = value),
    style: { setProperty: (name: string, value: string) => (style[name] = value) },
  }
  vm.runInNewContext(themeBootstrap, {
    localStorage: { getItem: (key: string) => storage[key] ?? null },
    document: { documentElement },
    matchMedia: (query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" && deviceDark,
    }),
    Date,
    JSON,
    String,
  })
  return { attributes, style }
}

const signedIn = () => String(Date.now() + 3_600_000)
const cache = (mode: string, extra = {}) =>
  JSON.stringify({
    v: "x",
    mode,
    figures: true,
    light: { id: "default", vars: null },
    dark: MOCHA,
    ...extra,
  })
const nothing = { attributes: {}, style: {} }

test("signed out, or with an expired session, a leftover theme is not applied", () => {
  assert.deepEqual(run({ [THEME_KEY]: cache("dark") }), nothing)
  assert.deepEqual(
    run({ "hafezi.signedInUntil": String(Date.now() - 1000), [THEME_KEY]: cache("dark") }),
    nothing,
  )
})

test("the site's own look sets nothing at all", () => {
  assert.deepEqual(
    run({ "hafezi.signedInUntil": signedIn(), [THEME_KEY]: cache("light") }),
    nothing,
  )
  assert.deepEqual(run({ "hafezi.signedInUntil": signedIn() }), nothing)
})

test("dark mode applies the dark theme's tokens, attributes and figure setting", () => {
  assert.deepEqual(run({ "hafezi.signedInUntil": signedIn(), [THEME_KEY]: cache("dark") }), {
    attributes: {
      "saved-theme": "dark",
      "data-palette": "catppuccin-mocha",
      "data-figures": "match",
    },
    style: MOCHA.vars,
  })
  const keep = run({
    "hafezi.signedInUntil": signedIn(),
    [THEME_KEY]: cache("dark", { figures: false }),
  })
  assert.equal(keep.attributes["data-figures"], "keep")
})

test("matching the device picks the dark theme only when the device is dark", () => {
  const storage = {
    "hafezi.signedInUntil": signedIn(),
    [THEME_KEY]: cache("system", { light: LATTE }),
  }
  assert.equal(run(storage, true).attributes["data-palette"], "catppuccin-mocha")
  assert.deepEqual(run(storage, false), {
    attributes: {
      "saved-theme": "light",
      "data-palette": "catppuccin-latte",
      "data-figures": "match",
    },
    style: LATTE.vars,
  })
})

test("a damaged copy is ignored", () => {
  for (const value of [
    "{",
    "null",
    "7",
    '"dark"',
    JSON.stringify({ mode: "dark", dark: { vars: 3 } }),
  ])
    assert.deepEqual(run({ "hafezi.signedInUntil": signedIn(), [THEME_KEY]: value }), nothing)
  // A property that isn't a custom property is not set.
  const odd = cache("dark", { dark: { ...MOCHA, vars: { color: "red", "--light": "#000" } } })
  assert.deepEqual(run({ "hafezi.signedInUntil": signedIn(), [THEME_KEY]: odd }).style, {
    "--light": "#000",
  })
})

test("small enough to inline in every member page", () => {
  assert.ok(themeBootstrap.length < 800, String(themeBootstrap.length))
})
