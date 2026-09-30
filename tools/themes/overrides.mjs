// Which schemes the theme picker offers, under which names, and the few colors a base16 file
// cannot say. Catppuccin and Rosé Pine name more tiers of text and surface than base16's sixteen
// slots hold, so theirs come from the projects' own palettes:
//   @catppuccin/palette (MIT, https://github.com/catppuccin/palette)
//   @rose-pine/palette  (MIT, https://github.com/rose-pine/palette)
// Every other color is read from the scheme's file in ./schemes (tinted-theming, MIT).
import { flavors } from "@catppuccin/palette"
import { variants } from "@rose-pine/palette"

/** [scheme file, display name, family], in the picker's order; everything else is "More themes". */
export const CURATED = [
  ["catppuccin-latte", "Catppuccin Latte", "Catppuccin"],
  ["catppuccin-frappe", "Catppuccin Frappé", "Catppuccin"],
  ["catppuccin-macchiato", "Catppuccin Macchiato", "Catppuccin"],
  ["catppuccin-mocha", "Catppuccin Mocha", "Catppuccin"],
  ["rose-pine-dawn", "Rosé Pine Dawn", "Rosé Pine"],
  ["rose-pine", "Rosé Pine", "Rosé Pine"],
  ["rose-pine-moon", "Rosé Pine Moon", "Rosé Pine"],
  ["nord-light", "Nord Light", "Nord"],
  ["nord", "Nord", "Nord"],
  ["dracula", "Dracula", "Dracula"],
  ["gruvbox-light-medium", "Gruvbox Light", "Gruvbox"],
  ["gruvbox-dark-soft", "Gruvbox Dark Soft", "Gruvbox"],
  ["gruvbox-dark-medium", "Gruvbox Dark", "Gruvbox"],
  ["gruvbox-dark-hard", "Gruvbox Dark Hard", "Gruvbox"],
  ["tokyo-night-light", "Tokyo Night Light", "Tokyo Night"],
  ["tokyo-night-dark", "Tokyo Night", "Tokyo Night"],
  ["tokyo-night-storm", "Tokyo Night Storm", "Tokyo Night"],
  ["tokyo-night-moon", "Tokyo Night Moon", "Tokyo Night"],
  ["solarized-light", "Solarized Light", "Solarized"],
  ["solarized-dark", "Solarized Dark", "Solarized"],
  ["selenized-light", "Selenized Light", "Solarized"],
  ["everforest-light-medium", "Everforest Light", "Everforest"],
  ["everforest-dark-medium", "Everforest Dark", "Everforest"],
  ["everforest-dark-hard", "Everforest Dark Hard", "Everforest"],
  ["kanagawa", "Kanagawa", "Kanagawa"],
  ["kanagawa-dragon", "Kanagawa Dragon", "Kanagawa"],
  ["one-light", "One Light", "One"],
  ["onedark", "One Dark", "One"],
  ["github", "GitHub Light", "GitHub"],
  ["github-dark", "GitHub Dark", "GitHub"],
  ["github-dark-dimmed", "GitHub Dark Dimmed", "GitHub"],
  ["ayu-light", "Ayu Light", "Ayu"],
  ["ayu-mirage", "Ayu Mirage", "Ayu"],
  ["ayu-dark", "Ayu Dark", "Ayu"],
  ["monokai", "Monokai", "Monokai"],
  ["material-palenight", "Material Palenight", "Material"],
  ["oxocarbon-dark", "Oxocarbon Dark", "Oxocarbon"],
  ["papercolor-light", "PaperColor Light", "PaperColor"],
]

/** Names the scheme files spell in a way that reads badly in a list. */
export const RENAMED = {
  "selenized-black": "Selenized Black",
  "selenized-dark": "Selenized Dark",
  "selenized-white": "Selenized White",
  tender: "Tender",
  "everforest-light-hard": "Everforest Light Hard",
  "everforest-light-soft": "Everforest Light Soft",
  "gruvbox-dark-pale": "Gruvbox Dark Pale",
  "gruvbox-light-hard": "Gruvbox Light Hard",
  "gruvbox-light-soft": "Gruvbox Light Soft",
  "gruvbox-material-dark-medium": "Gruvbox Material Dark",
  "gruvbox-material-light-medium": "Gruvbox Material Light",
  "synth-midnight-dark": "Synth Midnight",
  onedark: "One Dark",
  oceanicnext: "Oceanic Next",
  irblack: "IR Black",
  "default-dark": "Base16 Default Dark",
  "default-light": "Base16 Default Light",
  mocha: "Base16 Mocha",
}

/** Scheme files whose name would collide with one of the site's own theme ids. */
export const IDS = {
  "default-dark": "base16-default-dark",
  "default-light": "base16-default-light",
}

const hex = (value) => "#" + String(value).replace(/^#/, "").toLowerCase()

const catppuccin = (flavor) => {
  const c = Object.fromEntries(Object.entries(flavor.colors).map(([name, v]) => [name, v.hex]))
  return {
    surface1: c.mantle,
    surface2: c.surface0,
    rule: c.surface1,
    muted: c.subtext0,
    comment: c.overlay1,
    text: c.text,
    heading: c.text,
    band: flavor.dark ? c.crust : undefined,
    accent: c.red,
    ok: c.green,
    warn: c.yellow,
    err: c.red,
    info: c.blue,
    focus: c.lavender,
  }
}

const rosePine = (variant) => {
  const c = Object.fromEntries(
    Object.entries(variant.colors).map(([name, v]) => [name, hex(v.hex)]),
  )
  return {
    surface1: c.surface,
    surface2: c.overlay,
    rule: c.highlightMed,
    muted: c.subtle,
    comment: c.muted,
    text: c.text,
    heading: c.text,
    accent: c.love,
    ok: c.pine,
    warn: c.gold,
    err: c.love,
    info: c.foam,
    focus: c.iris,
  }
}

/** Colors for roles, before contrast repair, that replace the ones read from the scheme file. */
export const OVERRIDES = {
  "catppuccin-latte": catppuccin(flavors.latte),
  "catppuccin-frappe": catppuccin(flavors.frappe),
  "catppuccin-macchiato": catppuccin(flavors.macchiato),
  "catppuccin-mocha": catppuccin(flavors.mocha),
  "rose-pine": rosePine(variants.main),
  "rose-pine-moon": rosePine(variants.moon),
  "rose-pine-dawn": rosePine(variants.dawn),
}

// Hafezi Dark, the site's own dark theme: neutral grays (Quartz's stock dark set, which
// quartz.config.yaml has carried all along), the brand red lifted until it passes on them, and
// github-dark's code colors, which is what code blocks already use on a dark page.
export const HAFEZI_DARK = {
  id: "default-dark",
  name: "Hafezi Dark",
  family: "Hafezi",
  variant: "dark",
  palette: {
    base00: "#161618",
    base01: "#1d1d21",
    base02: "#2a2a2f",
    base03: "#6a737d",
    base04: "#a8a8b0",
    base05: "#d4d4d4",
    base06: "#ebebec",
    base07: "#ffffff",
    base08: "#ffab70",
    base09: "#79b8ff",
    base0A: "#ffea7f",
    base0B: "#9ecbff",
    base0C: "#85e89d",
    base0D: "#b392f0",
    base0E: "#f97583",
    base0F: "#fdaeb7",
  },
  overrides: { accent: "#e21833", err: "#f97583", rule: "#393639" },
}
