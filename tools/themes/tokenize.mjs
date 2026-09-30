// Puts the vendored hafezi.jqi.umd.edu stylesheet (quartz/styles/_jqi-theme.scss, a minified
// Tailwind build) onto the site's color tokens (frontend/theme/tokens.js): each color becomes
// var(--token,<the color>), so the sheet renders exactly as before until a theme sets the token.
// The token depends on the property, since one color does two jobs there: #fff is the page under
// `background` and the text on a dark band under `color`.
// `npm run sync-theme` runs this on each refresh; detokenize() undoes it exactly.
import { TOKENS } from "../../frontend/theme/tokens.js"

const SURFACE = /^background(?:-color)?$/
const TEXT = /^(?:color|fill|stroke|text-decoration(?:-color)?|caret-color)$/
const BORDER = /^(?:border|outline|column-rule)(?:-[a-z-]+)?$/

/** color → [properties, token] in order; the first whose properties match wins. */
const RULES = {
  "#fff": [
    [SURFACE, "--light"],
    [BORDER, "--light"],
    [TEXT, "--c-on-band"],
  ],
  "#222": [
    [SURFACE, "--c-band"],
    [TEXT, "--dark"],
    [BORDER, "--dark"],
  ],
  "#454545": [
    [SURFACE, "--c-band"],
    [TEXT, "--darkgray"],
    [BORDER, "--darkgray"],
  ],
  "#000": [
    [SURFACE, "--c-band"],
    [TEXT, "--c-strong"],
  ],
  "#e21833": [[/./, "--secondary"]],
  "#e6e6e6": [
    [SURFACE, "--c-surface-2"],
    [BORDER, "--lightgray"],
  ],
  "rgb(230 230 230/var(--tw-bg-opacity,1))": [[SURFACE, "--c-surface-2"]],
  "#f5f5f5": [[SURFACE, "--c-surface-1"]],
  "#fff1e2": [[SURFACE, "--c-warn-softer"]],
  "#e7e7e7": [[BORDER, "--c-rule"]],
  "#ddd": [[BORDER, "--c-rule"]],
  "#d0d0d0": [[BORDER, "--c-rule"]],
  "#d7d2d2": [[BORDER, "--c-rule"]],
  "rgba(69,69,69,.15)": [[BORDER, "--c-rule"]],
  "#909090": [[BORDER, "--c-muted"]],
  "#3e3e3e": [[TEXT, "--c-strong"]],
  "#4a4a4a": [[TEXT, "--c-muted"]],
  "#575757": [[TEXT, "--c-muted"]],
  "#9ca3af": [[TEXT, "--c-muted"]],
  "#003281": [[/./, "--c-info"]],
  "#001a4a": [[TEXT, "--c-info"]],
  "#2d4eb2": [[SURFACE, "--c-info"]],
}

// Colors that are the same in every theme: shadows (black or gray at a low alpha) and Tailwind's
// own variables, which hold no color the page shows.
const FIXED_PROPERTY = /^(?:box-shadow|text-shadow|--tw-[a-z-]+)$/

const COLOR =
  /rgb\(230 230 230\/var\(--tw-bg-opacity,1\)\)|#[0-9a-fA-F]{3,8}\b|(?:rgb|hsl)a?\([^()]*\)/g

/** The text of a rule's white-on-something: on the accent it is the accent's own text color. */
function onFill(declarations) {
  const fill = declarations.find(([property]) => SURFACE.test(property))?.[1] ?? ""
  return /#e21833|#2d4eb2|#003281/i.test(fill) ? "--c-on-accent" : "--c-on-band"
}

function tokenFor(color, property, declarations) {
  const rules = RULES[color.toLowerCase()]
  const token = rules?.find(([properties]) => properties.test(property))?.[1]
  if (!token) return null
  return token === "--c-on-band" ? onFill(declarations) : token
}

/** Splits a block's body into [property, value] pairs, keeping `;` inside parentheses and strings. */
function declarationsOf(body) {
  const out = []
  let depth = 0
  let quote = ""
  let start = 0
  const push = (end) => {
    const text = body.slice(start, end)
    const colon = text.indexOf(":")
    out.push(colon < 0 ? [text, null] : [text.slice(0, colon), text.slice(colon + 1)])
    start = end + 1
  }
  for (let at = 0; at < body.length; at++) {
    const char = body[at]
    if (quote) {
      if (char === "\\") at++
      else if (char === quote) quote = ""
    } else if (char === '"' || char === "'") quote = char
    else if (char === "(") depth++
    else if (char === ")") depth--
    else if (char === ";" && depth === 0) push(at)
  }
  push(body.length)
  return out
}

/**
 * @param {string} css  minified CSS
 * @param {{unknown?: (color: string, property: string) => void}} [report]  told of each color in a
 *   color property that no rule names, so a refresh that brings a new color is noticed
 */
export function tokenize(css, report = {}) {
  // Innermost blocks only (rules, and the rules inside @media): a block with no brace inside it.
  return css.replace(/\{([^{}]*)\}/g, (_, body) => {
    const declarations = declarationsOf(body)
    const named = declarations.map(([property, value]) => [property.trim().toLowerCase(), value])
    return (
      "{" +
      declarations
        .map(([property, value], index) => {
          if (value === null) return property
          const name = named[index][0]
          if (FIXED_PROPERTY.test(name) || /url\(/.test(value)) return `${property}:${value}`
          const themed = value.replace(COLOR, (color, offset) => {
            // Already a token's fallback.
            if (/var\(--[\w-]+,$/.test(value.slice(0, offset))) return color
            const token = tokenFor(color, name, named)
            if (!token) {
              if (SURFACE.test(name) || TEXT.test(name) || BORDER.test(name))
                report.unknown?.(color, name)
              return color
            }
            return `var(${token},${color})`
          })
          return `${property}:${themed}`
        })
        .join(";") +
      "}"
    )
  })
}

const TOKEN = new RegExp(`^var\\(\\s*(?:${TOKENS.join("|")})\\s*,\\s*`)

/**
 * Every var(--token,fallback) of a color token put back to its fallback: the stylesheet as the
 * default theme renders it. Other variables (Tailwind's own) are left alone.
 */
export function detokenize(css) {
  let out = ""
  for (let at = 0; at < css.length;) {
    const open = TOKEN.exec(css.slice(at, at + 96))
    if (!open) {
      out += css[at++]
      continue
    }
    let depth = 1
    let end = at + open[0].length
    for (; end < css.length && depth; end++)
      depth += css[end] === "(" ? 1 : css[end] === ")" ? -1 : 0
    out += detokenize(css.slice(at + open[0].length, end - 1))
    at = end
  }
  return out
}
