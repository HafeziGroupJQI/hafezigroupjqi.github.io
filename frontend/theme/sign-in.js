// At sign-in (frontend/members/pages.js), before the first member page: the member's saved theme
// into this browser's copy, so a new device paints its first page in it rather than light.
import { DEFAULT_PREFS, buildCache, clearCache, writeCache } from "./cache.js"
import { DEFAULT_LIGHT } from "./tokens.js"

/**
 * Fetched straight from the Worker with the new bearer token (no service worker needed). Gives up
 * quietly: the first member page then asks for the theme itself.
 */
export async function primeTheme(api, token, { storage = localStorage, fetcher = fetch } = {}) {
  const headers = { authorization: `Bearer ${token}` }
  const response = await fetcher(`${api}/api/prefs`, { headers })
  if (!response.ok) return
  const prefs = { ...DEFAULT_PREFS, ...(await response.json()).theme }
  // The site's own look: nothing to keep, and no theme data to fetch.
  if (prefs.mode === "light" && prefs.light === DEFAULT_LIGHT) return clearCache(storage)
  const data = await fetcher(`${api}/api/site/static/themes.json`, { headers })
  if (!data.ok) return
  writeCache(storage, buildCache(prefs, await data.json()))
}
