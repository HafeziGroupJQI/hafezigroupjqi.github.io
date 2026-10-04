// The access rules snapshot the members build applies (tools/acl/snapshot.mjs), read from the
// Worker's D1 (worker/migrations/0018_acl.sql) at deploy time. It never comes from vault-private,
// which every member can push to: a member could otherwise weaken a rule for the build.
//
//   node tools/acl/export-snapshot.mjs <out.json> [--database hafezi-members]
//     (with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, as the deploy's other D1 steps)
// The snapshot is the Worker's (worker/src/acl/index.ts readSnapshot), made from the same queries.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const QUERIES = {
  meta: "SELECT version FROM acl_meta WHERE id = 1",
  groups: "SELECT id, name FROM acl_groups ORDER BY name",
  members: "SELECT group_id, login, person FROM acl_group_members ORDER BY login, person",
  rules:
    "SELECT id, pattern, allow_json, deny_json, note FROM acl_rules ORDER BY CAST(substr(id, 2) AS INTEGER), id",
}

/** A rule's principals from their JSON column; anything but a list of strings stops the export. */
function principals(raw, rule, column) {
  let value
  try {
    value = JSON.parse(raw ?? "[]")
  } catch {
    value = null
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`acl_rules ${rule}: ${column} is not a JSON list of principals`)
  return value
}

/** The snapshot (`{version, groups, rules}`) from the four queries' rows. */
export function snapshotFromRows({ meta = [], groups = [], members = [], rules = [] }) {
  const out = { version: Number(meta[0]?.version ?? 0), groups: {}, rules: [] }
  const byId = new Map()
  for (const group of groups) {
    byId.set(Number(group.id), group.name)
    out.groups[group.name] = { logins: [], people: [] }
  }
  for (const member of members) {
    const group = out.groups[byId.get(Number(member.group_id))]
    if (!group) continue
    if (member.login) group.logins.push(String(member.login).toLowerCase())
    if (member.person) group.people.push(String(member.person))
  }
  for (const rule of rules)
    out.rules.push({
      id: String(rule.id),
      pattern: String(rule.pattern),
      allow: principals(rule.allow_json, rule.id, "allow_json"),
      deny: principals(rule.deny_json, rule.id, "deny_json"),
      note: rule.note ?? "",
    })
  return out
}

/** One query's rows from `wrangler d1 execute --json` output. */
export function wranglerRows(stdout) {
  const answer = JSON.parse(stdout.slice(stdout.indexOf("[")))
  const [first] = Array.isArray(answer) ? answer : [answer]
  if (!first || first.success === false) throw new Error(`d1 query failed: ${stdout.slice(0, 300)}`)
  return first.results ?? []
}

function query(database, sql, workerDir) {
  const bin = path.join(workerDir, "node_modules", ".bin", "wrangler")
  const run = spawnSync(bin, ["d1", "execute", database, "--remote", "--json", "--command", sql], {
    cwd: workerDir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  if (run.status !== 0) throw new Error(`wrangler d1 execute failed:\n${run.stderr || run.stdout}`)
  return wranglerRows(run.stdout)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const at = args.indexOf("--database")
  const database = at >= 0 ? args[at + 1] : "hafezi-members"
  const out = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--database")
  if (!out) {
    console.error("usage: node tools/acl/export-snapshot.mjs <out.json> [--database <name>]")
    process.exit(2)
  }
  const workerDir = fileURLToPath(new URL("../../worker", import.meta.url))
  const rows = Object.fromEntries(
    Object.entries(QUERIES).map(([name, sql]) => [name, query(database, sql, workerDir)]),
  )
  const snapshot = snapshotFromRows(rows)
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2) + "\n")
  console.log(
    `access rules snapshot: version ${snapshot.version}, ${Object.keys(snapshot.groups).length} groups, ${snapshot.rules.length} rules in ${out}`,
  )
}
