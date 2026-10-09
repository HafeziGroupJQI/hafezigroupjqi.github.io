// A member's theme in this browser: their saved choice (GET /api/prefs, worker/src/prefs.ts) with
// the two themes it names resolved to tokens from /static/themes.json (tools/themes/build.mjs),
// kept in localStorage so every page can paint in it at once. The inline head script
// (quartz/components/jqi/themeBootstrap.ts) applies this same copy before the page paints; keep
// resolve() and applyTheme() in step with it.
import { DEFAULT_DARK, DEFAULT_LIGHT, TOKENS } from "./tokens.js"

export const THEME_KEY = "hafezi.theme"
/** When this browser last asked the Worker for the member's choice. */
export const SYNC_KEY = "hafezi.themeSyncedAt"
export const SYNC_EVERY = 10 * 60 * 1000

export const DEFAULT_PREFS = {
  mode: "light",
  light: DEFAULT_LIGHT,
  dark: DEFAULT_DARK,
  figures: true,
  wrap: true,
}

const entry = (theme) =>
  theme
    ? {
        id: theme.id,
        name: theme.name,
        polarity: theme.polarity,
        vars: theme.vars,
        base: theme.base,
      }
    : null

/**
 * The copy to keep: the member's choice, and the two themes it names. An id this build does not
 * know (a theme since removed) falls back to the site's own theme for that slot.
 */
export function buildCache(prefs, data) {
  const byId = new Map(data.themes.map((theme) => [theme.id, theme]))
  const pick = (id, fallback) => entry(byId.get(id) ?? byId.get(fallback))
  return {
    v: data.v,
    mode: ["light", "dark", "system"].includes(prefs.mode) ? prefs.mode : "light",
    figures: prefs.figures !== false,
    wrap: prefs.wrap !== false,
    prefs: {
      mode: prefs.mode,
      light: prefs.light,
      dark: prefs.dark,
      figures: prefs.figures,
      wrap: prefs.wrap,
    },
    light: pick(prefs.light, DEFAULT_LIGHT),
    dark: pick(prefs.dark, DEFAULT_DARK),
  }
}

/** Whether a saved choice is what this copy was built from. */
export const samePrefs = (cache, prefs) =>
  !!cache?.prefs &&
  ["mode", "light", "dark", "figures", "wrap"].every((key) => cache.prefs[key] === prefs[key])

/** The theme to show now: the dark one when dark mode is on, or on and the device is dark. */
export function resolve(cache, deviceDark) {
  if (!cache) return null
  return cache.mode === "dark" || (cache.mode === "system" && deviceDark) ? cache.dark : cache.light
}

export function readCache(storage) {
  try {
    const cache = JSON.parse(storage.getItem(THEME_KEY) ?? "null")
    return cache && typeof cache === "object" ? cache : null
  } catch {
    return null
  }
}

export function writeCache(storage, cache) {
  try {
    storage.setItem(THEME_KEY, JSON.stringify(cache))
  } catch {
    /* private mode or full: the page still applies it */
  }
}

/** Sign-out: nothing of the member's look is left in the browser. */
export function clearCache(storage) {
  try {
    storage.removeItem(THEME_KEY)
    storage.removeItem(SYNC_KEY)
  } catch {
    /* ignore */
  }
}

/** Puts a theme on <html>, clearing the one before (null, or a theme without tokens: the site's own look). */
export function applyTheme(root, theme, figures = true) {
  for (const token of TOKENS) root.style.removeProperty(token)
  if (!theme?.vars) {
    root.removeAttribute("saved-theme")
    root.removeAttribute("data-palette")
    root.removeAttribute("data-figures")
    return
  }
  root.setAttribute("saved-theme", theme.polarity === "dark" ? "dark" : "light")
  root.setAttribute("data-palette", theme.id)
  root.setAttribute("data-figures", figures ? "match" : "keep")
  for (const [token, value] of Object.entries(theme.vars))
    if (/^--[\w-]+$/.test(token)) root.style.setProperty(token, String(value))
}

/**
 * Whether long lines in code blocks wrap (data-code-wrap="on") or scroll ("off") for the member, on
 * <html>; null (no copy: signed out) takes the attribute away, and the site's own scrolling applies.
 * The CSS is quartz/plugins/local/code-blocks. Independent of the theme: the site's own look wraps too.
 */
export function applyCodeWrap(root, wrap) {
  if (wrap === null || wrap === undefined) root.removeAttribute("data-code-wrap")
  else root.setAttribute("data-code-wrap", wrap === false ? "off" : "on")
}

/** The lab's theme message (compute's labextensions, lib/theme.ts): light or dark, and the palette. */
export function labMessage(theme) {
  const dark = theme?.polarity === "dark"
  const message = { type: "hafezi-theme", theme: dark ? "dark" : "light" }
  if (theme?.vars && theme.base) message.palette = { id: theme.id, ...theme.base }
  return message
}
