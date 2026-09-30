// The site's color tokens: every color in the stylesheets is one of these custom properties.
// Hafezi Light (the look of the public site and of a member who picked nothing) sets none of
// them: Quartz's nine come from quartz.config.yaml, and every other use carries today's color as
// its fallback, `var(--c-rule, #ddd)`. A member's theme (tools/themes/map.mjs) sets them all on
// <html>, and the print stylesheet unsets them all, so paper stays light.

/** Quartz's own nine (quartz/util/theme.ts), with the meaning each has on this site. */
export const QUARTZ = [
  "--light", // the page
  "--lightgray", // rules and borders
  "--gray", // muted text, and the borders of controls
  "--darkgray", // body text
  "--dark", // headings
  "--secondary", // the accent: links, the active tab, the main button
  "--tertiary", // the accent under the pointer
  "--highlight", // a tint of the accent behind a hovered or current item
  "--textHighlight", // marked text and search hits
]

/** Colors Quartz has no name for. */
export const ROLES = [
  "--c-surface-1", // raised: cards, code, inputs, table stripes
  "--c-surface-2", // hovered and selected items, chips
  "--c-rule", // soft borders
  "--c-muted", // secondary text
  "--c-strong", // the darkest text
  "--c-band", // dark bands: the footer, table heads, dark buttons
  "--c-on-band", // text on a band
  "--c-band-rule", // rules on a band
  "--c-on-accent", // text on the accent or on a status color
  "--c-accent-soft", // tints of the accent behind text
  "--c-accent-softer",
  "--c-ok", // status: text, borders and fills
  "--c-ok-soft",
  "--c-ok-softer",
  "--c-warn",
  "--c-warn-soft",
  "--c-warn-softer",
  "--c-err",
  "--c-err-soft",
  "--c-err-softer",
  "--c-info",
  "--c-info-soft",
  "--c-info-softer",
  "--c-focus", // focus rings
]

/** Code colors, by base16's roles for its slots 03 and 08 to 0E. */
export const SYNTAX = [
  "--syn-comment",
  "--syn-variable",
  "--syn-constant",
  "--syn-class",
  "--syn-string",
  "--syn-support",
  "--syn-function",
  "--syn-keyword",
]

/** How figures with a light background are matched to the page (quartz/styles/_figures.scss). */
export const FIGURE = ["--fig-filter", "--fig-blend"]

export const TOKENS = [...QUARTZ, ...ROLES, ...SYNTAX, ...FIGURE]

/** The theme a member has when they have picked nothing, and the one dark mode starts on. */
export const DEFAULT_LIGHT = "default"
export const DEFAULT_DARK = "default-dark"
