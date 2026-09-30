// The members edition's theme data: /static/themes.json, every theme the settings page offers with
// its resolved tokens (tools/themes/themes.mjs). Read by /settings and when a member's saved theme
// is put in the browser's cache (frontend/theme/). The public edition has none.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { loadThemes } from "./themes.mjs"

export const THEMES_FILE = "static/themes.json"

/** The theme data and its version, a hash of its content that browsers' caches are keyed on. */
export function themeData() {
  const themes = loadThemes()
  const v = crypto.createHash("sha256").update(JSON.stringify(themes)).digest("hex").slice(0, 12)
  return { v, themes }
}

/** Writes /static/themes.json into a built site and returns its version. */
export function writeThemes(output) {
  const data = themeData()
  const file = path.join(output, THEMES_FILE)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data))
  return data.v
}
