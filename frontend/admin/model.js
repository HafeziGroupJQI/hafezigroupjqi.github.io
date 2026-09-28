// Pure helpers for the admin console (unit-tested in model.test.mjs).

export const ACTION_GROUPS = [
  ["", "All actions"],
  ["auth", "Sign-ins & sign-outs"],
  ["gpt", "Hafezi GPT"],
  ["device", "Devices"],
  ["doc", "Private documents"],
  ["admin", "Admin changes"],
  ["api", "Other writes"],
]

/** Query string for GET /api/admin/audit(.csv) from the filter form. Dates are local days. */
export function auditParams(
  { login = "", action = "", since = "", until = "" } = {},
  beforeId = null,
  limit = 100,
) {
  const params = new URLSearchParams()
  if (login.trim()) params.set("login", login.trim().replace(/^@/, ""))
  if (action) params.set("action", action)
  if (since) params.set("since", String(new Date(`${since}T00:00:00`).getTime()))
  // "until" is inclusive of the whole chosen day.
  if (until) params.set("until", String(new Date(`${until}T00:00:00`).getTime() + 86_400_000))
  if (beforeId != null) params.set("before_id", String(beforeId))
  if (limit) params.set("limit", String(limit))
  return params
}

const LABELS = {
  "auth.login": "signed in",
  "auth.logout": "signed out",
  "auth.denied": "was refused sign-in",
  "device.create": "registered device",
  "device.revoke": "revoked device",
  "doc.view": "opened",
  "admin.promote": "made admin",
  "admin.demote": "removed admin",
  "admin.budget": "set GPT budget for",
  "admin.audit.export": "exported the audit log",
  "gpt.message": "asked Hafezi GPT in",
  "gpt.share": "shared chat",
  "gpt.unshare": "unshared chat",
  "gpt.fork": "continued a shared chat",
  "gpt.upload": "uploaded",
  "gpt.project.create": "created project",
  "gpt.project.update": "updated project",
  "gpt.project.delete": "deleted project",
  "gpt.skill.create": "created skill",
  "gpt.skill.update": "updated skill",
  "gpt.skill.delete": "deleted skill",
  "gpt.conversation.delete": "deleted chat",
}

/** One human sentence per audit row, e.g. "signed in", "registered device bec-main". */
export function describe(row) {
  const label = LABELS[row.action] ?? row.action
  const detail = row.detail ?? {}
  let text = row.target && !row.action.startsWith("auth.") ? `${label} ${row.target}` : label
  if (row.action === "gpt.message") {
    const tokens = (detail.input ?? 0) + (detail.output ?? 0)
    text += ` · ${detail.model ?? ""} · ${formatTokens(tokens)} tokens`
    if (detail.mentions?.length) text += ` · @${detail.mentions.length}`
  }
  if (row.action === "gpt.share" && detail.grantee)
    text += ` with ${detail.grantee === "*" ? "the whole lab" : detail.grantee}`
  if (row.action.startsWith("api.") && row.status) text += ` → ${row.status}`
  return text
}

export function formatTokens(n) {
  if (n == null) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

export const formatUsd = (n) => `$${(n ?? 0).toFixed(2)}`

export function formatWhen(at, now = Date.now()) {
  const date = new Date(at)
  const sameDay = new Date(now).toDateString() === date.toDateString()
  const time = date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
  return sameDay
    ? time
    : `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} ${time}`
}

/** Share of the monthly budget used, 0–1, or null when there is no budget. */
export function budgetUsed(member) {
  if (member.monthly_tokens == null) return null
  if (member.monthly_tokens === 0) return 1
  return Math.min(1, (member.input + member.output) / member.monthly_tokens)
}

/** Parse the budget field: "" → null (no limit), "2M"/"500k"/"1500000" → tokens. */
export function parseBudget(text) {
  const t = String(text)
    .trim()
    .toLowerCase()
    .replace(/[,_\s]/g, "")
  if (!t) return null
  const m = t.match(/^(\d+(?:\.\d+)?)([km]?)$/)
  if (!m) throw new Error("Enter a number of tokens, like 2M or 500k, or leave empty for no limit.")
  return Math.round(Number(m[1]) * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1))
}

/** The tab a key moves to in a tab list (Left/Right wrap, Home/End), or null for other keys. */
export function nextTab(index, key, count) {
  if (key === "ArrowRight") return (index + 1) % count
  if (key === "ArrowLeft") return (index - 1 + count) % count
  if (key === "Home") return 0
  if (key === "End") return count - 1
  return null
}
