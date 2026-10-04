// The members site's access rules (per-page ACLs), as the build applies them. The Worker has the
// same semantics in worker/src/acl/policy.ts; both pass worker/test/acl-vectors.json.
//
// A snapshot is `{version, groups: {<name>: {logins, people}}, rules: [{id, pattern, allow, deny}]}`
// (the deploy exports it from the Worker's D1, tools/acl/export-snapshot.mjs). Paths are vault paths: relative to
// vault-private's root, with their extension, no leading slash ("notes/x.qmd"). A pattern is an
// exact file ("notes/x.md"), a folder ("dir/", everything below it) or a glob ("*" one segment, "**"
// any depth). The most specific matching rule decides: an exact file, then the longest folder, then
// the longest glob; ties go to the lowest id. No matching rule: every member reads the path.

/** The snapshot with every field present (a missing file or field means no rules). */
export function normalizeSnapshot(snapshot) {
  const groups = {}
  for (const [name, group] of Object.entries(snapshot?.groups ?? {}))
    groups[name] = {
      logins: (group?.logins ?? []).map((login) => String(login).toLowerCase()),
      people: (group?.people ?? []).map(String),
    }
  const rules = (snapshot?.rules ?? []).map((rule) => ({
    id: String(rule.id),
    pattern: String(rule.pattern).replace(/^\/+/, ""),
    allow: (rule.allow ?? []).map(String),
    deny: (rule.deny ?? []).map(String),
    ...(rule.note !== undefined ? { note: rule.note } : {}),
  }))
  return { version: Number(snapshot?.version ?? 0), groups, rules }
}

/** A pattern's kind: "exact", "folder" or "glob". */
export const patternKind = (pattern) =>
  pattern.includes("*") ? "glob" : pattern.endsWith("/") ? "folder" : "exact"

const globs = new Map()
/** A glob as a regular expression over a whole vault path: "**\/" any folders (none too), "**"
 *  anything, "*" one segment's worth. A glob ending in "/" is a folder's: everything below too. */
export function globPattern(pattern) {
  if (!globs.has(pattern)) {
    let source = ""
    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i]
      if (char === "*" && pattern[i + 1] === "*") {
        const folders = pattern[i + 2] === "/"
        source += folders ? "(?:.*/)?" : ".*"
        i += folders ? 2 : 1
      } else if (char === "*") source += "[^/]*"
      else source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    }
    globs.set(pattern, new RegExp(`^${source}${pattern.endsWith("/") ? ".*" : ""}$`, "s"))
  }
  return globs.get(pattern)
}

/** Whether a rule's pattern matches a vault path. */
export function matches(pattern, vaultPath) {
  const kind = patternKind(pattern)
  if (kind === "exact") return vaultPath === pattern
  if (kind === "folder") return vaultPath.startsWith(pattern)
  return globPattern(pattern).test(vaultPath)
}

const RANK = { exact: 3, folder: 2, glob: 1 }
// Of two rules as specific, the lower id: by the number in ids like "r12" (r2 before r10).
const idNumber = (id) => {
  const match = /^[a-z]*(\d+)$/i.exec(id)
  return match ? Number(match[1]) : null
}
const lowerId = (a, b) => {
  const [x, y] = [idNumber(a.id), idNumber(b.id)]
  if (x !== null && y !== null && x !== y) return x < y
  return a.id < b.id
}

/** The rule that decides a vault path, or null when none matches. */
export function decidingRule(snapshot, vaultPath) {
  const path = String(vaultPath).replace(/^\/+/, "")
  let best = null
  for (const rule of snapshot.rules) {
    if (!matches(rule.pattern, path)) continue
    if (!best) {
      best = rule
      continue
    }
    const rank = RANK[patternKind(rule.pattern)] - RANK[patternKind(best.pattern)]
    const length = rule.pattern.length - best.pattern.length
    if (rank > 0 || (rank === 0 && (length > 0 || (length === 0 && lowerId(rule, best)))))
      best = rule
  }
  return best
}

/** The acl key of a vault path (its deciding rule's id), or null when it isn't restricted. */
export const aclKey = (snapshot, vaultPath) => decidingRule(snapshot, vaultPath)?.id ?? null

/** Whether a principal ("group:x", "login:x", "person:people/x") names this member. */
export function names(snapshot, principal, { login = null, person = null } = {}) {
  const at = principal.indexOf(":")
  const kind = principal.slice(0, at)
  const name = principal.slice(at + 1)
  const own = login ? String(login).toLowerCase() : null
  if (kind === "login") return own !== null && name.toLowerCase() === own
  if (kind === "person") return person !== null && name === person
  if (kind === "group") {
    const group = snapshot.groups[name]
    return Boolean(
      group && ((own && group.logins.includes(own)) || (person && group.people.includes(person))),
    )
  }
  return false
}

/**
 * Whether a member reads a vault path: `{readable, rule}`, rule the deciding rule's id or null.
 * `who` is `{login, person (people/<slug>), admin}`; admins read everything.
 */
export function canRead(snapshot, vaultPath, who = {}) {
  const rule = decidingRule(snapshot, vaultPath)
  if (!rule) return { readable: true, rule: null }
  if (who.admin) return { readable: true, rule: rule.id }
  const named = (principal) => names(snapshot, principal, who)
  const readable = (rule.allow.length === 0 || rule.allow.some(named)) && !rule.deny.some(named)
  return { readable, rule: rule.id }
}
