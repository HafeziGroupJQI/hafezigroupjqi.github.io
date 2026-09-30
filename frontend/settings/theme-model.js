// The Appearance section's model (frontend/settings/theme.js): which themes each picker offers,
// grouped as the picker shows them, and what the section says about the member's choice.

/** Dark mode: off, on, or as the device is set. */
export const MODES = [
  ["light", "Off"],
  ["dark", "On"],
  ["system", "Match my device"],
]

export const MORE = "More themes"

/** The themes one picker offers: the light ones for light mode, the dark ones for dark mode. */
export const slotThemes = (themes, polarity) =>
  themes.filter((theme) => theme.polarity === polarity)

/** Families in the order the list has them (the site's own first), "More themes" last. */
export function groups(themes) {
  const order = []
  const byFamily = new Map()
  for (const theme of themes) {
    if (!byFamily.has(theme.family)) {
      byFamily.set(theme.family, [])
      order.push(theme.family)
    }
    byFamily.get(theme.family).push(theme)
  }
  order.sort((a, b) => (a === MORE) - (b === MORE))
  return order.map((family) => ({ family, themes: byFamily.get(family) }))
}

const fold = (text) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()

/** A search matches a theme's name or family, ignoring case and accents ("rose" finds Rosé Pine). */
export function matches(theme, query) {
  const words = fold(query).split(/\s+/).filter(Boolean)
  const text = fold(`${theme.name} ${theme.family}`)
  return words.every((word) => text.includes(word))
}

const nameOf = (themes, id) => themes.find((theme) => theme.id === id)?.name ?? "the site's own"

/** One sentence on what the member sees now. */
export function summary(prefs, themes) {
  const light = nameOf(themes, prefs.light)
  const dark = nameOf(themes, prefs.dark)
  if (prefs.mode === "dark") return `Dark mode is on: you see ${dark}.`
  if (prefs.mode === "system")
    return `You see ${light} when your device is in light mode, and ${dark} when it is in dark mode.`
  return `Dark mode is off: you see ${light}.`
}
