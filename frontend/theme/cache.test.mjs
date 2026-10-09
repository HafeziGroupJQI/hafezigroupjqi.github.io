import test from "node:test"
import assert from "node:assert/strict"
import { themeData } from "../../tools/themes/build.mjs"
import {
  DEFAULT_PREFS,
  SYNC_KEY,
  THEME_KEY,
  applyCodeWrap,
  applyTheme,
  buildCache,
  clearCache,
  labMessage,
  readCache,
  resolve,
  samePrefs,
  writeCache,
} from "./cache.js"
import { primeTheme } from "./sign-in.js"
import { TOKENS } from "./tokens.js"

const data = themeData()

function storage(initial = {}) {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  }
}

function element() {
  const attributes = new Map()
  const properties = new Map()
  return {
    attributes,
    properties,
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    style: {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: (name) => properties.delete(name),
    },
  }
}

test("a copy holds the member's choice and both themes it names, resolved", () => {
  const cache = buildCache(
    { mode: "system", light: "catppuccin-latte", dark: "rose-pine-moon", figures: false },
    data,
  )
  assert.equal(cache.v, data.v)
  assert.equal(cache.mode, "system")
  assert.equal(cache.figures, false)
  assert.equal(cache.light.id, "catppuccin-latte")
  assert.equal(cache.dark.vars["--light"], "#232136")
  assert.equal(cache.dark.base.base00, "#232136")
  assert.equal(resolve(cache, true).id, "rose-pine-moon")
  assert.equal(resolve(cache, false).id, "catppuccin-latte")
  assert.ok(
    samePrefs(cache, {
      mode: "system",
      light: "catppuccin-latte",
      dark: "rose-pine-moon",
      figures: false,
    }),
  )
  assert.ok(!samePrefs(cache, { ...DEFAULT_PREFS }))
})

test("a theme this build doesn't know falls back to the site's own for its slot", () => {
  const cache = buildCache({ mode: "dark", light: "gone", dark: "gone-too", figures: true }, data)
  assert.equal(cache.light.id, "default")
  assert.equal(cache.light.vars, null)
  assert.equal(cache.dark.id, "default-dark")
  assert.equal(
    resolve(buildCache({ ...DEFAULT_PREFS, mode: "nonsense" }, data), true).id,
    "default",
  )
})

test("the site's own look needs only its own entry, and leaves the dark slot empty", () => {
  const plain = { v: "x", themes: [{ id: "default", polarity: "light", vars: null }] }
  const cache = buildCache(DEFAULT_PREFS, plain)
  assert.equal(cache.light.id, "default")
  assert.equal(cache.dark, null)
  assert.equal(resolve(cache, true).vars, null)
})

test("applying a theme sets its tokens and attributes, and the site's look clears them all", () => {
  const root = element()
  const cache = buildCache({ ...DEFAULT_PREFS, mode: "dark", dark: "nord" }, data)
  applyTheme(root, resolve(cache, false), false)
  assert.equal(root.getAttribute("saved-theme"), "dark")
  assert.equal(root.getAttribute("data-palette"), "nord")
  assert.equal(root.getAttribute("data-figures"), "keep")
  assert.deepEqual([...root.properties.keys()].sort(), [...TOKENS].sort())
  applyTheme(root, cache.light)
  assert.equal(root.attributes.size, 0)
  assert.equal(root.properties.size, 0)
})

test("the copy survives damage, and sign-out removes it", () => {
  const store = storage({ [THEME_KEY]: "{", [SYNC_KEY]: "1" })
  assert.equal(readCache(store), null)
  writeCache(store, { v: "x" })
  assert.deepEqual(readCache(store), { v: "x" })
  clearCache(store)
  assert.equal(store.items.size, 0)
})

test("the lab gets light or dark, and a named theme's sixteen colors by base16 slot", () => {
  const cache = buildCache({ ...DEFAULT_PREFS, mode: "dark", dark: "catppuccin-mocha" }, data)
  const message = labMessage(resolve(cache, false))
  assert.equal(message.type, "hafezi-theme")
  assert.equal(message.theme, "dark")
  assert.equal(message.palette.id, "catppuccin-mocha")
  assert.equal(message.palette.base00, "#1e1e2e")
  const slots = Object.keys(message.palette).filter((key) => key !== "id")
  assert.equal(slots.length, 16)
  for (const slot of slots) assert.match(message.palette[slot], /^#[0-9a-f]{6}$/)
  // The site's own look: the lab keeps its own light theme, as before.
  assert.deepEqual(labMessage(null), { type: "hafezi-theme", theme: "light" })
  assert.deepEqual(labMessage(cache.light), { type: "hafezi-theme", theme: "light" })
})

test("sign-in puts a saved theme in the copy, and keeps nothing for the site's look", async () => {
  const calls = []
  const fetcher = (prefs) => async (url, init) => {
    calls.push([url, init.headers.authorization])
    if (url.endsWith("/api/prefs")) return Response.json({ theme: prefs, updated_at: 1 })
    return Response.json(data)
  }
  const store = storage()
  await primeTheme("https://api.test", "tok", {
    storage: store,
    fetcher: fetcher({ ...DEFAULT_PREFS, mode: "dark", dark: "dracula" }),
  })
  assert.deepEqual(calls, [
    ["https://api.test/api/prefs", "Bearer tok"],
    ["https://api.test/api/site/static/themes.json", "Bearer tok"],
  ])
  assert.equal(readCache(store).dark.id, "dracula")
  calls.length = 0
  const plain = storage({ [THEME_KEY]: "{}" })
  await primeTheme("https://api.test", "tok", { storage: plain, fetcher: fetcher(DEFAULT_PREFS) })
  assert.equal(calls.length, 1)
  assert.equal(plain.items.size, 0)
})

test("a copy carries the member's choice of wrapping code blocks, on unless they turned it off", () => {
  assert.equal(DEFAULT_PREFS.wrap, true)
  const on = buildCache({ ...DEFAULT_PREFS }, data)
  assert.equal(on.wrap, true)
  const off = buildCache({ ...DEFAULT_PREFS, wrap: false }, data)
  assert.equal(off.wrap, false)
  assert.equal(off.prefs.wrap, false)
  // A copy from before the setting existed is rebuilt: it no longer matches the saved choice.
  const old = {
    prefs: { mode: "light", light: DEFAULT_PREFS.light, dark: DEFAULT_PREFS.dark, figures: true },
  }
  assert.ok(!samePrefs(old, { ...DEFAULT_PREFS }))
  assert.ok(samePrefs(off, { ...DEFAULT_PREFS, wrap: false }))
  assert.ok(!samePrefs(off, { ...DEFAULT_PREFS }))
})

test("the wrap choice goes on <html> whatever the theme, and signing out takes it away", () => {
  const root = element()
  applyCodeWrap(root, true)
  assert.equal(root.getAttribute("data-code-wrap"), "on")
  applyCodeWrap(root, false)
  assert.equal(root.getAttribute("data-code-wrap"), "off")
  // The site's own look clears the theme's attributes but not the wrap choice.
  applyTheme(root, null)
  assert.equal(root.getAttribute("data-code-wrap"), "off")
  applyCodeWrap(root, null)
  assert.equal(root.getAttribute("data-code-wrap"), null)
})
