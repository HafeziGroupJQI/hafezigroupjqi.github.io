// Pure helpers for the admin console (unit-tested in model.test.mjs).

export const ACTION_GROUPS = [
  ["", "All actions"],
  ["auth", "Sign-ins & sign-outs"],
  ["gpt", "Hafezi GPT"],
  ["device", "Devices"],
  ["doc", "Private documents"],
  ["uploads", "Uploads"],
  ["edit", "Page edits"],
  ["admin", "Admin changes"],
  ["admin.compute", "Admins reading members' code"],
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
  "admin.profile.approve": "approved the People page claim of",
  "admin.profile.reject": "turned down the People page claim of",
  "profile.claim": "asked to link People page",
  "uploads.create": "started upload draft",
  "uploads.stage": "staged",
  "uploads.rename": "staged a move of",
  "uploads.delete": "staged the deletion of",
  "uploads.unstage": "took out of a draft",
  "uploads.note": "edited the note of upload draft",
  "uploads.send": "sent upload draft",
  "uploads.discard": "discarded upload draft",
  "uploads.merge": "had upload draft merged:",
  "uploads.failed": "had upload draft fail the vault's check:",
  "uploads.conflict": "had upload draft conflict with main:",
  "uploads.review": "had upload draft left for an admin:",
  "uploads.closed": "had upload draft closed on GitHub:",
  "admin.uploads.discard": "discarded the upload draft",
  "admin.compute.sessions": "looked at the live sessions of",
  "admin.compute.ipython": "read the IPython history of",
  "admin.compute.bash": "read the terminal history of",
  "admin.compute.files": "read the file history of",
  "edit.create": "started editing",
  "edit.save": "saved an edit of",
  "edit.send": "sent an edit of",
  "edit.discard": "discarded edit draft",
  "edit.merge": "had edit draft merged:",
  "edit.failed": "had edit draft fail the vault's check:",
  "edit.conflict": "had edit draft conflict with main:",
  "edit.review": "had edit draft left for an admin:",
  "edit.closed": "had edit draft closed on GitHub:",
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
  if (row.action === "uploads.rename" && detail.to) text += ` to ${detail.to}`
  if (row.action === "uploads.send" && detail.pull) text += ` as pull request #${detail.pull}`
  if (row.action === "admin.uploads.discard" && detail.login) text += ` of ${detail.login}`
  if (row.action === "admin.compute.files" && detail.rev)
    text += ` · commit ${detail.rev.slice(0, 7)}`
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

/** Where Hafezi GPT's usage came from (gpt_usage_daily's source). */
export const USAGE_SOURCES = { chat: "Site chat", agent: "Coding agent", completion: "Ghost text" }

/** A model and a source, e.g. "Haiku 4.5 · Ghost text". */
export const usageLabel = (row) =>
  `${row.label ?? row.model} · ${USAGE_SOURCES[row.source] ?? row.source}`

/**
 * A month's usage by day (GET /api/admin/usage `days`) as a table: a column per model and
 * source, the costliest first, and a row per day, the latest first, with its total.
 */
export function usageByDay(days) {
  const columns = new Map()
  const rows = new Map()
  for (const d of days) {
    const key = `${d.model}|${d.source}`
    const column = columns.get(key) ?? { key, label: usageLabel(d), cost_usd: 0 }
    column.cost_usd += d.cost_usd
    columns.set(key, column)
    const row = rows.get(d.day) ?? { day: d.day, cells: {}, cost_usd: 0 }
    row.cells[key] = d
    row.cost_usd += d.cost_usd
    rows.set(d.day, row)
  }
  return {
    columns: [...columns.values()].sort(
      (a, b) => b.cost_usd - a.cost_usd || a.label.localeCompare(b.label),
    ),
    rows: [...rows.values()].sort((a, b) => b.day.localeCompare(a.day)),
  }
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

// The deep-link keys each tab keeps: Conversations ?member=&c=, Code ?member=&view=&commit=.
const DEEP_LINKS = { conversations: ["member", "c"], code: ["member", "view", "commit"] }

/** The page URL for a tab: deep-link keys of other tabs are dropped (a member stays selected
 *  between Conversations and Code). */
export function tabUrl(href, tab) {
  const url = new URL(href)
  url.searchParams.set("tab", tab)
  const keep = DEEP_LINKS[tab] ?? []
  for (const key of ["member", "c", "view", "commit"])
    if (!keep.includes(key)) url.searchParams.delete(key)
  return url.toString()
}

/** The Code tab's views of a member (?view=), in order. */
export const CODE_VIEWS = [
  ["live", "Live"],
  ["ipython", "IPython"],
  ["bash", "Terminal"],
  ["files", "Files"],
]

/** Query string of a Code tab read: the member, then the paging (since: a local day, YYYY-MM-DD). */
export function codeQuery(login, { since = "", before = null, offset = 0, limit = null } = {}) {
  const params = new URLSearchParams({ login })
  if (limit != null) params.set("limit", String(limit))
  if (since) params.set("since", String(new Date(`${since}T00:00:00`).getTime()))
  if (before != null) params.set("before", String(before))
  if (offset) params.set("offset", String(offset))
  return params.toString()
}

/** IPython inputs, newest first, in runs of one session each (a heading per run). */
export function sessionRuns(entries) {
  const runs = []
  for (const entry of entries) {
    const last = runs.at(-1)
    if (last && last.session === entry.session) last.entries.push(entry)
    else runs.push({ session: entry.session, at: entry.at, entries: [entry] })
  }
  return runs
}

/** A commit's diff line by line, each with what it is: the stat, a file's header lines, a hunk
 *  heading, an added or removed line, or context. */
export function diffLines(text) {
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  let part = "stat"
  return lines.map((line) => {
    if (line.startsWith("diff --git ")) {
      part = "header"
      return { kind: "file", text: line }
    }
    if (part !== "stat" && line.startsWith("@@")) {
      part = "hunk"
      return { kind: "hunk", text: line }
    }
    if (part === "stat") return { kind: "stat", text: line }
    if (part === "header" || line.startsWith("\\")) return { kind: "meta", text: line }
    if (line.startsWith("+")) return { kind: "add", text: line }
    if (line.startsWith("-")) return { kind: "del", text: line }
    return { kind: "context", text: line }
  })
}

/** The tab a key moves to in a tab list (Left/Right wrap, Home/End), or null for other keys. */
export function nextTab(index, key, count) {
  if (key === "ArrowRight") return (index + 1) % count
  if (key === "ArrowLeft") return (index - 1 + count) % count
  if (key === "Home") return 0
  if (key === "End") return count - 1
  return null
}

/** What waits for an admin on the Uploads tab: drafts to merge by hand and conflicts to settle. */
export const uploadsWaiting = (drafts, conflicts = []) =>
  drafts.filter((draft) => draft.status === "review").length + conflicts.length
