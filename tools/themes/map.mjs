// A base16 scheme (tinted-theming's sixteen slots, https://github.com/tinted-theming/home, MIT)
// as the site's color tokens (frontend/theme/tokens.js). The slots follow base16's styling guide:
// 00 background, 01 lighter background, 02 selection, 03 comments, 04 dark foreground,
// 05 foreground, 06 light foreground, 08 to 0E the accent hues by what they color in code.
//
// No color is made up here. Each role takes a slot's color and, where that color would be hard to
// read, steps it toward white or black until it reaches WCAG 2's contrast ratio for its use
// (wcag-contrast, BSD-2-Clause): 4.5 for text, 3 for comments and focus rings. Tints are a color
// mixed into the background.
import { hex as ratio } from "wcag-contrast"
import { TOKENS } from "../../frontend/theme/tokens.js"

const SLOTS = [
  ...["00", "01", "02", "03", "04", "05", "06", "07"],
  ...["08", "09", "0A", "0B", "0C", "0D", "0E", "0F"],
].map((slot) => "base" + slot)

const HEX = /^#[0-9a-f]{6}$/

export const normalize = (value) => {
  const text = String(value).trim().toLowerCase().replace(/^#?/, "#")
  if (!HEX.test(text)) throw new Error(`not a color: ${value}`)
  return text
}

const channels = (color) => [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16))
const toHex = (rgb) =>
  "#" + rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")

/** `amount` of `b` mixed into `a`. */
export function mix(a, b, amount) {
  const [x, y] = [channels(a), channels(b)]
  return toHex(x.map((value, index) => value + (y[index] - value) * amount))
}

export const contrast = (a, b) => ratio(a, b)

const worst = (color, grounds) => Math.min(...grounds.map((ground) => contrast(color, ground)))

/**
 * `color`, stepped toward white or black (whichever reads better on the grounds) until it has
 * `target` contrast on every one of `grounds`. A color that already has it comes back unchanged.
 */
export function repair(color, grounds, target) {
  if (worst(color, grounds) >= target) return color
  const pole = worst("#ffffff", grounds) >= worst("#000000", grounds) ? "#ffffff" : "#000000"
  for (let step = 1; step <= 64; step++) {
    const stepped = mix(color, pole, step / 64)
    if (worst(stepped, grounds) >= target) return stepped
  }
  return pole
}

/** `color` stepped toward `ground` until the two are no further apart than `most`. */
function soften(color, ground, most) {
  for (let step = 0; step <= 64; step++) {
    const stepped = mix(color, ground, step / 64)
    if (contrast(stepped, ground) <= most) return stepped
  }
  return ground
}

function hueOf(color) {
  const [r, g, b] = channels(color)
  const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)]
  const chroma = max - min
  if (!chroma) return { hue: 0, chroma }
  const hue =
    max === r ? ((g - b) / chroma + 6) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4
  return { hue: hue * 60, chroma }
}

const apart = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

/**
 * The accent slot nearest a hue. base16 names its accents by what they color in code, and some
 * schemes put another hue in the "red" or "green" slot (GitHub's 08 is brown, Rosé Pine's 0B is
 * pine), so a status color looks for its hue first and falls back to the slot.
 */
function nearest(palette, hue, fallback) {
  let best = null
  for (const slot of SLOTS.slice(8)) {
    const found = hueOf(palette[slot])
    const distance = apart(found.hue, hue)
    if (found.chroma < 40 || distance > 40) continue
    if (!best || distance < best.distance) best = { distance, color: palette[slot] }
  }
  return best ? best.color : palette[fallback]
}

const alpha = (color, amount) => `rgba(${channels(color).join(", ")}, ${amount})`

/**
 * @param {{id: string, name: string, family?: string, variant?: string,
 *   palette: Record<string, string>, overrides?: Record<string, string | undefined>}} scheme
 * @returns {{id: string, name: string, family: string, polarity: "light" | "dark",
 *   vars: Record<string, string>, base: Record<string, string>, swatch: string[]}}
 */
export function mapScheme(scheme) {
  const palette = Object.fromEntries(
    SLOTS.map((slot) => {
      if (scheme.palette?.[slot] === undefined) throw new Error(`${scheme.id}: no ${slot}`)
      return [slot, normalize(scheme.palette[slot])]
    }),
  )
  const over = Object.fromEntries(
    Object.entries(scheme.overrides ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([role, value]) => [role, normalize(value)]),
  )
  const bg = palette.base00
  // A scheme is as dark as its background, whatever its file says.
  const polarity = contrast(bg, "#ffffff") >= contrast(bg, "#000000") ? "dark" : "light"
  const dark = polarity === "dark"

  // Surfaces stay near the page, so one color of text reads on all three.
  const surface1 = soften(over.surface1 ?? palette.base01, bg, 1.15)
  const surface2 = soften(over.surface2 ?? palette.base02, bg, 1.35)
  // Text has its full contrast on the page and on cards, and at least 3 on a hovered item.
  const grounds = [bg, surface1]
  const text = (color, target = 4.5) =>
    repair(repair(color, grounds, target), [surface2], Math.min(target, 3))

  // Borders: visible on the page, and quieter than text.
  let rule = soften(over.rule ?? palette.base02, bg, dark ? 1.8 : 1.6)
  if (contrast(rule, bg) < 1.2) {
    const toward = over.text ?? palette.base05
    for (let step = 1; step <= 64 && contrast(rule, bg) < 1.2; step++)
      rule = mix(over.rule ?? palette.base02, toward, step / 64)
  }

  let body = text(over.text ?? palette.base05)
  // base06 is a brighter foreground in most schemes and an accent in a few (Catppuccin's
  // rosewater): a heading takes it only when it is the text's own hue, or gray.
  const [six, five] = [hueOf(palette.base06), hueOf(palette.base05)]
  const neutral = six.chroma < 16 || (five.chroma >= 16 && apart(six.hue, five.hue) <= 40)
  let heading = text(
    over.heading ??
      (neutral && worst(palette.base06, grounds) > worst(body, grounds) ? palette.base06 : body),
  )
  // Muted text: base04 where it is quieter than the text, else the comment color.
  const four = text(palette.base04)
  const muted = text(
    over.muted ??
      (worst(four, grounds) <= worst(body, grounds) * 0.85 ? palette.base04 : palette.base03),
  )

  const accent = text(over.accent ?? nearest(palette, 0, "base08"))
  const hover = text(mix(accent, heading, 0.35))
  const status = {
    ok: over.ok ?? nearest(palette, 120, "base0B"),
    warn: over.warn ?? nearest(palette, 45, "base0A"),
    err: over.err ?? over.accent ?? nearest(palette, 0, "base08"),
    info: over.info ?? nearest(palette, 215, "base0D"),
  }
  const tints = {}
  for (const [name, color] of [["accent", accent], ...Object.entries(status)]) {
    // The tints are made from the color as first repaired; the color is then repaired once more
    // so that it also reads on its own tints (a warning's text on a warning's background).
    const first = text(color)
    const soft = mix(bg, first, 0.16)
    const softer = mix(bg, first, 0.08)
    tints[name] = { color: repair(first, [...grounds, soft, softer], 4.5), soft, softer }
  }
  // Body text must read on every tint as well: a tint that defeats it is thinned, and where the
  // text has no contrast to spare even then, the text is stepped a little further.
  for (const tint of Object.values(tints))
    for (const key of ["soft", "softer"])
      for (let step = 0; step < 6 && contrast(body, tint[key]) < 4.5; step++)
        tint[key] = mix(tint[key], bg, 0.25)
  const tinted = Object.values(tints).flatMap((tint) => [tint.soft, tint.softer])
  body = repair(body, tinted, 4.5)
  heading = repair(heading, tinted, 4.5)

  // Bands are the dark strips of the light site (footer, table heads, dark buttons). On a dark
  // theme they are a raised surface; on a light one, the text color with the page's on it.
  const band = dark ? (over.band ?? surface2) : heading
  const onBand = repair(dark ? heading : bg, [band], 4.5)

  // Text on a fill of the accent or a status color: the page's own color, which those colors
  // were just repaired against.
  const fills = Object.values(tints).map((tint) => tint.color)
  const onAccent = worst(bg, fills) >= 4.5 ? bg : repair(bg, fills, 4.5)

  const syntax = (slot) => text(palette[slot])
  const comment = text(over.comment ?? palette.base03, 3)

  const vars = {
    "--light": bg,
    "--lightgray": rule,
    "--gray": muted,
    "--darkgray": body,
    "--dark": heading,
    "--secondary": tints.accent.color,
    "--tertiary": hover,
    "--highlight": alpha(tints.accent.color, 0.12),
    "--textHighlight": alpha(status.warn, 0.35),
    "--c-surface-1": surface1,
    "--c-surface-2": surface2,
    "--c-rule": rule,
    "--c-muted": muted,
    "--c-strong": heading,
    "--c-band": band,
    "--c-on-band": onBand,
    "--c-band-rule": mix(band, onBand, 0.25),
    "--c-on-accent": onAccent,
    "--c-accent-soft": tints.accent.soft,
    "--c-accent-softer": tints.accent.softer,
    "--c-ok": tints.ok.color,
    "--c-ok-soft": tints.ok.soft,
    "--c-ok-softer": tints.ok.softer,
    "--c-warn": tints.warn.color,
    "--c-warn-soft": tints.warn.soft,
    "--c-warn-softer": tints.warn.softer,
    "--c-err": tints.err.color,
    "--c-err-soft": tints.err.soft,
    "--c-err-softer": tints.err.softer,
    "--c-info": tints.info.color,
    "--c-info-soft": tints.info.soft,
    "--c-info-softer": tints.info.softer,
    "--c-focus": text(over.focus ?? tints.info.color, 3),
    "--syn-comment": comment,
    "--syn-variable": syntax("base08"),
    "--syn-constant": syntax("base09"),
    "--syn-class": syntax("base0A"),
    "--syn-string": syntax("base0B"),
    "--syn-support": syntax("base0C"),
    "--syn-function": syntax("base0D"),
    "--syn-keyword": syntax("base0E"),
    // A figure drawn on white is matched to the page: inverted with its hues kept on a dark
    // theme, and blended so its white takes the page's color (quartz/styles/_figures.scss).
    "--fig-filter": dark ? "invert(1) hue-rotate(180deg)" : "none",
    "--fig-blend": dark ? "screen" : bg === "#ffffff" ? "normal" : "multiply",
  }
  const missing = TOKENS.filter((token) => !(token in vars))
  const extra = Object.keys(vars).filter((token) => !TOKENS.includes(token))
  if (missing.length || extra.length)
    throw new Error(`token list and mapping disagree: ${[...missing, ...extra].join(" ")}`)

  // The same colors by slot, for the lab (JupyterLab maps base16 slots to its own variables).
  const base = {
    ...palette,
    base00: bg,
    base01: surface1,
    base02: surface2,
    base03: comment,
    base04: muted,
    base05: body,
    base06: heading,
    base08: vars["--syn-variable"],
    base09: vars["--syn-constant"],
    base0A: vars["--syn-class"],
    base0B: vars["--syn-string"],
    base0C: vars["--syn-support"],
    base0D: vars["--syn-function"],
    base0E: vars["--syn-keyword"],
  }
  return {
    id: scheme.id,
    name: scheme.name,
    family: scheme.family ?? "More themes",
    polarity,
    vars,
    base,
    swatch: [
      bg,
      body,
      tints.accent.color,
      vars["--syn-keyword"],
      vars["--syn-function"],
      vars["--syn-string"],
      vars["--syn-constant"],
    ],
  }
}
