// Value formatting shared by every view. Pure: no DOM.

const SPECIAL = { NaN: "NaN", Inf: "+∞", "-Inf": "−∞" }

/** A reading value: finite numbers to 6 significant digits, the wire's "NaN"/"Inf" strings kept. */
export function fmtValue(value, units) {
  let text
  if (value == null || value === "") text = "—"
  else if (typeof value === "string" && value in SPECIAL) text = SPECIAL[value]
  else if (typeof value === "number" && Number.isFinite(value)) {
    const abs = Math.abs(value)
    text =
      abs !== 0 && (abs < 1e-3 || abs >= 1e6)
        ? value.toExponential(4)
        : String(Number(value.toPrecision(6)))
  } else text = String(value)
  return units && text !== "—" ? `${text} ${units}` : text
}

export const fmtInt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—")

/** ns-since-epoch (decimal string or number) → ms, or null. */
export function nsToMs(tsNs) {
  if (tsNs == null || tsNs === "") return null
  try {
    return Number(BigInt(String(tsNs).split(".")[0]) / 1_000_000n)
  } catch {
    const n = Number(tsNs)
    return Number.isFinite(n) ? n / 1e6 : null
  }
}

/** "12 s ago" style from a ns timestamp. */
export function relTime(tsNs, now) {
  const ms = nsToMs(tsNs)
  if (ms == null) return "—"
  const s = Math.max(0, Math.floor((now - ms) / 1000))
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

export function clockTime(ms) {
  if (ms == null) return "—"
  return new Date(ms).toLocaleTimeString("en-US", { hour12: false })
}

/** Compact one-line summary of a command's args ({local_id: "x"} → "local_id=x"). */
export function argsSummary(args) {
  if (!args || typeof args !== "object") return ""
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" · ")
    .slice(0, 160)
}
