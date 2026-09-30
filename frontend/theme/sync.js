// A member's theme on every member page (loaded by frontend/member-tools.js once signed in). The
// head script has already painted the page from this browser's copy; this keeps that copy right:
// the member's choice is asked for again at most every ten minutes (or at once, after a deploy
// changed the themes), a change made in another tab shows at once, and "Match my device" follows
// the device. Each change is announced as Quartz's `themechange` event, which the graph, Mermaid
// and Excalidraw redraw on.
import {
  DEFAULT_PREFS,
  SYNC_EVERY,
  SYNC_KEY,
  THEME_KEY,
  applyTheme,
  buildCache,
  readCache,
  resolve,
  samePrefs,
  writeCache,
} from "./cache.js"
import { DEFAULT_LIGHT } from "./tokens.js"

/* global __THEMES_VERSION__ */
/** The version of /static/themes.json this build carries (tools/members-bundles.mjs). */
export const THEMES_VERSION = typeof __THEMES_VERSION__ !== "undefined" ? __THEMES_VERSION__ : ""

const deviceDark = () => !!window.matchMedia?.("(prefers-color-scheme: dark)").matches

/** The theme showing now (null: the site's own look). */
export const currentTheme = () => resolve(readCache(localStorage), deviceDark())

/** Puts a copy's theme on the page and tells everything that draws in the theme's colors. */
export function show(cache) {
  applyTheme(document.documentElement, resolve(cache, deviceDark()), cache?.figures !== false)
  const theme = document.documentElement.getAttribute("saved-theme") === "dark" ? "dark" : "light"
  document.dispatchEvent(new CustomEvent("themechange", { detail: { theme } }))
}

let loading = null
/** Every theme, with its tokens (tools/themes/build.mjs). */
export function themeData() {
  loading ??= fetch(`/static/themes.json?v=${THEMES_VERSION}`).then((response) => {
    if (!response.ok) throw new Error(`The themes could not be loaded (${response.status}).`)
    return response.json()
  })
  loading.catch(() => (loading = null))
  return loading
}

/** The site's own look needs no theme data: nothing to fetch for a member who kept it. */
const plain = (prefs) => prefs.mode === "light" && prefs.light === DEFAULT_LIGHT

/** Keeps `prefs` as this browser's copy and shows it. */
export async function remember(prefs) {
  const data = plain(prefs)
    ? { v: THEMES_VERSION, themes: [{ id: DEFAULT_LIGHT, polarity: "light", vars: null }] }
    : await themeData()
  const cache = buildCache(prefs, data)
  writeCache(localStorage, cache)
  try {
    localStorage.setItem(SYNC_KEY, String(Date.now()))
  } catch {
    /* ignore */
  }
  show(cache)
  return cache
}

/** Asks the Worker for the member's choice when the copy is old, missing or from another build. */
export async function refresh({ force = false } = {}) {
  const cache = readCache(localStorage)
  const synced = Number(localStorage.getItem(SYNC_KEY)) || 0
  const current = cache?.v === THEMES_VERSION
  if (!force && current && Date.now() - synced < SYNC_EVERY) return
  const response = await fetch("/api/prefs", { cache: "no-store" })
  if (!response.ok) return
  const prefs = { ...DEFAULT_PREFS, ...(await response.json()).theme }
  if (current && samePrefs(cache, prefs)) {
    localStorage.setItem(SYNC_KEY, String(Date.now()))
    return
  }
  await remember(prefs)
}

let started = false
export function startThemeSync() {
  if (started) return
  started = true
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_KEY) show(readCache(localStorage))
  })
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    const cache = readCache(localStorage)
    if (cache?.mode === "system") show(cache)
  })
  refresh().catch(() => {})
}
