// Pure helpers for Wolfram notebook pages (no DOM access, unit-tested in cells.test.mjs).

/** The ids listed in a cell's data-prelude ("c3 c5" → ["c3", "c5"]). */
export const preludeIds = (value) =>
  String(value ?? "")
    .split(/\s+/)
    .filter(Boolean)

/**
 * The prelude codes for a cell: the code of each definition cell it names, in page order,
 * skipping ids that are missing or have no code. `codeOf(id)` returns a cell's current code
 * (edited text when the member changed it) or null.
 */
export function preludeCodes(value, codeOf) {
  const codes = []
  for (const id of preludeIds(value)) {
    const code = codeOf(id)
    if (typeof code === "string" && code.trim()) codes.push(code)
  }
  return codes
}

export const runPayload = ({ page, cell, code, prelude }) => ({
  page: String(page ?? ""),
  cell: String(cell ?? ""),
  code,
  prelude,
})

/** Human text for a failed compute call. */
export function failureMessage(status, data) {
  if (status === 503)
    return "Compute host offline. Try again later, or open the notebook in the Scratchpad."
  if (status === 429)
    return typeof data?.detail === "string"
      ? data.detail
      : "Too many runs. Wait a minute and retry."
  if (typeof data?.detail === "string") return data.detail
  return `The compute host returned an error (${status}).`
}

/**
 * A failure message in pieces, with "Settings (/settings)" as a link: Wolfram code runs on the
 * member's own licence, and the host's message for a missing one says where to add it.
 */
export function messageParts(message) {
  const at = message.indexOf("Settings (/settings)")
  if (at === -1) return [message]
  return [
    message.slice(0, at),
    { href: "/settings", text: "Settings" },
    message.slice(at + "Settings (/settings)".length),
  ].filter((part) => part !== "")
}

/** Parse data-controls: [{name, label, values}] with at least one value each. */
export function parseControls(raw) {
  try {
    const controls = JSON.parse(raw ?? "[]")
    return Array.isArray(controls)
      ? controls
          .filter((control) => Array.isArray(control?.values) && control.values.length)
          .map((control) => ({
            name: String(control.name ?? ""),
            label: String(control.label ?? control.name ?? ""),
            values: control.values,
            // Index of the Manipulate's initial value (the snapshot's state), default 0.
            initial: Math.min(
              Math.max(0, Math.trunc(Number(control.initial) || 0)),
              control.values.length - 1,
            ),
          }))
      : []
  } catch {
    return []
  }
}

/** Row-major frame index for per-control value indices (2 controls: i0 * len1 + i1). */
export function frameIndex(controls, indices) {
  let index = 0
  controls.forEach((control, k) => {
    const i = Math.min(Math.max(0, Math.trunc(indices[k] ?? 0)), control.values.length - 1)
    index = index * control.values.length + i
  })
  return index
}

/**
 * CSS background placement for frame `index` of a cols×rows sprite grid, as percentages so the
 * player scales with its container: background-size (cols*100%) (rows*100%).
 */
export function spriteStyle(index, cols, rows) {
  const col = index % cols
  const row = Math.floor(index / cols)
  const pct = (i, n) => (n > 1 ? (i / (n - 1)) * 100 : 0)
  return {
    size: `${cols * 100}% ${rows * 100}%`,
    position: `${pct(col, cols)}% ${pct(row, rows)}%`,
  }
}

/** Display text for a control value (numbers trimmed to 4 significant digits). */
export const valueLabel = (value) =>
  typeof value === "number" && !Number.isInteger(value)
    ? String(Number(value.toPrecision(4)))
    : typeof value === "string"
      ? value
      : JSON.stringify(value)

/** Normalize symbols.json ([{n,u}] | [name] | {symbols: …}) to [{name, usage}]. */
export function normalizeSymbols(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.symbols) ? data.symbols : []
  return list
    .map((entry) =>
      typeof entry === "string"
        ? { name: entry, usage: "" }
        : {
            name: String(entry?.n ?? entry?.name ?? ""),
            usage: String(entry?.u ?? entry?.usage ?? ""),
          },
    )
    .filter((entry) => entry.name)
}

/** Symbols starting with `prefix` (case-sensitive first, then case-insensitive), capped. */
export function matchSymbols(symbols, prefix, limit = 50) {
  if (!prefix) return []
  const exact = []
  const loose = []
  const lower = prefix.toLowerCase()
  for (const symbol of symbols) {
    if (symbol.name.startsWith(prefix)) exact.push(symbol)
    else if (symbol.name.toLowerCase().startsWith(lower)) loose.push(symbol)
    if (exact.length >= limit) break
  }
  return [...exact, ...loose].slice(0, limit)
}
