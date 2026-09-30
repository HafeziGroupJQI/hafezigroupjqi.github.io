// Every theme the site offers, mapped onto its tokens: Hafezi Light (no tokens at all: it is the
// stylesheet as written), Hafezi Dark, the curated schemes in the picker's order, then the rest
// of ./schemes by name. The scheme files are tinted-theming's (MIT, ./schemes/LICENSE), copied
// unchanged from https://github.com/tinted-theming/schemes at commit d70255b.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "yaml"
import { DEFAULT_LIGHT } from "../../frontend/theme/tokens.js"
import { mapScheme } from "./map.mjs"
import { CURATED, HAFEZI_DARK, IDS, OVERRIDES, RENAMED } from "./overrides.mjs"

const SCHEMES = fileURLToPath(new URL("./schemes/", import.meta.url))

export const HAFEZI_LIGHT = {
  id: DEFAULT_LIGHT,
  name: "Hafezi Light",
  family: "Hafezi",
  polarity: "light",
  vars: null,
  // base16's slots for the site as it is, for the lab.
  base: {
    ...{ base00: "#ffffff", base01: "#f7f7f7", base02: "#e6e6e6", base03: "#6a737d" },
    ...{ base04: "#555555", base05: "#454545", base06: "#222222", base07: "#111111" },
    ...{ base08: "#e36209", base09: "#005cc5", base0A: "#b08800", base0B: "#032f62" },
    ...{ base0C: "#22863a", base0D: "#6f42c1", base0E: "#d73a49", base0F: "#b31d28" },
  },
  swatch: ["#ffffff", "#454545", "#e21833", "#d73a49", "#6f42c1", "#032f62", "#005cc5"],
}

const read = (file) => yaml.parse(fs.readFileSync(path.join(SCHEMES, file + ".yaml"), "utf8"))

/** @returns {ReturnType<typeof mapScheme>[]} */
export function loadThemes() {
  const curated = new Set(CURATED.map(([file]) => file))
  const rest = fs
    .readdirSync(SCHEMES)
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => name.slice(0, -5))
    .filter((file) => !curated.has(file))
    .map((file) => [file, RENAMED[file] ?? read(file).name, undefined])
    .sort((a, b) => a[1].localeCompare(b[1]))
  const themes = [
    HAFEZI_LIGHT,
    mapScheme(HAFEZI_DARK),
    ...[...CURATED, ...rest].map(([file, name, family]) =>
      mapScheme({
        id: IDS[file] ?? file,
        name,
        family,
        palette: read(file).palette,
        overrides: OVERRIDES[file],
      }),
    ),
  ]
  const ids = new Set(themes.map((theme) => theme.id))
  if (ids.size !== themes.length) throw new Error("two themes share an id")
  return themes
}
