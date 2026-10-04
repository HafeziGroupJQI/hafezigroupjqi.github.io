// Every vault's commits into the Worker's changes table (D1, worker/migrations/0014_changes.sql), on
// every members deploy (worker/ci/members-site-deploy.yml): one row per file of a commit, credited as
// the pages' histories are (tools/history.mjs), so /recent lists changes made outside the site too.
// Idempotent: the table keeps one row per commit and file (changes_commit), and with --remote the
// import first asks D1 which commits it has (imported before, or recorded by the Worker as it merged
// a member's draft), then sends only the others, in statements under D1's 100 KB, through the query
// API (wrangler's --file would take the database offline while it imports).
//
//   node tools/changes-import.mjs --vault ../vault --vault-private ../vault-private --sql out.sql
//   node tools/changes-import.mjs --vault ../vault --vault-private ../vault-private --remote
//     [--restricted vault-optical-rl=../vault-optical-rl …]
// The restricted vaults (worker/vaults.json) come from --restricted, or else VAULT_RESTRICTED_DIRS
// (tools/acl/vaults.mjs): their rows carry the vault's own repo and the file's vault path (which is
// its repo path), so a commit made on GitHub to a restricted vault is listed like vault-private's.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "yaml"
import { KINDS, creditOf, people, readLog } from "./history.mjs"
import { excluded } from "./prepare-unified.mjs"
import { restrictedDirs } from "./acl/vaults.mjs"

export const COLUMNS = [
  "at",
  "login",
  "author",
  "repo",
  "path",
  "from_path",
  "slug",
  "kind",
  "state",
  "summary",
  "commit_sha",
  "added",
  "removed",
  "source",
]
/** Bytes per statement: D1 takes at most 100 KB of SQL in one. */
export const STATEMENT_MAX = 90_000
const ROWS_MAX = 200

/**
 * Whether a vault file is content the site shows: the public vault's content/ folder, and every
 * file of vault-private the member build copies (tools/prepare-unified.mjs), never a dotfile. A
 * restricted vault's (`prefix`, its folder in vault-private) only under its folder.
 */
export function isContent(repo, file, prefix = "") {
  const segments = file.split("/")
  if (segments.some((segment) => segment.startsWith("."))) return false
  if (repo === "vault") return segments[0] === "content" && segments.length > 1
  return file.startsWith(prefix) && !segments.some((segment) => excluded.has(segment))
}

/**
 * A vault file's page on the site, or null: the public vault's content/<slug>.md, and vault-private's
 * pages and notebooks under resources/ (a Quarto document's or a notebook's page has its name).
 * The Worker's copy of this is pageSlug in worker/src/changes.ts.
 */
export function pageSlug(repo, file) {
  if (repo === "vault") return /^content\/(.+)\.md$/.exec(file)?.[1] ?? null
  const page = /^(.+)\.(?:md|qmd|ipynb|nb)$/.exec(file)?.[1]
  return page ? `resources/${page}` : null
}

/** The People pages' records (slug and front matter) of the public vault's work tree, to credit by. */
export function peopleRecords(vaultRoot) {
  const content = path.join(vaultRoot, "content")
  const walk = (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
      )
  const people = path.join(content, "people")
  return (fs.existsSync(people) ? walk(people) : [])
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const front = fs.readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)
      let fm = {}
      try {
        fm = (front && yaml.parse(front[1])) ?? {}
      } catch {}
      const slug = path.relative(content, file).split(path.sep).join("/").replace(/\.md$/, "")
      return { slug, fm }
    })
}

/** The changes table's rows for one vault's commits (readLog), its content files only. */
export function changeRows(repo, commits, known, { prefix = "" } = {}) {
  const rows = []
  for (const commit of commits)
    for (const file of commit.files) {
      if (!isContent(repo, file.path, prefix) && !(file.from && isContent(repo, file.from, prefix)))
        continue
      const { login, name } = creditOf(commit, file.path, known)
      rows.push({
        at: commit.at,
        login,
        author: name,
        repo,
        path: file.path,
        from_path: file.from,
        slug: file.status === "D" ? null : pageSlug(repo, file.path),
        kind: KINDS[file.status] ?? "edit",
        state: "merged",
        summary: commit.subject.slice(0, 500),
        commit_sha: commit.sha,
        added: file.added,
        removed: file.removed,
        source: "git",
      })
    }
  return rows
}

/** A value as an SQL literal on one line (D1's exec takes a statement a line): newlines, which a
 *  path could hold, as char(10) and char(13). */
export function literal(value) {
  if (value === null || value === undefined) return "NULL"
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL"
  const parts = String(value)
    .split(/(\r|\n)/)
    .filter((part) => part !== "")
    .map((part) =>
      part === "\n" ? "char(10)" : part === "\r" ? "char(13)" : `'${part.replace(/'/g, "''")}'`,
    )
  return parts.join(" || ") || "''"
}

/** INSERT OR IGNORE statements holding every row, each on one line and under STATEMENT_MAX. */
export function insertStatements(rows) {
  const head = `INSERT OR IGNORE INTO changes (${COLUMNS.join(", ")}) VALUES `
  const statements = []
  const base = Buffer.byteLength(head) + 1
  let values = []
  let size = base
  const flush = () => {
    if (values.length) statements.push(`${head}${values.join(", ")};`)
    values = []
    size = base
  }
  for (const row of rows) {
    const value = `(${COLUMNS.map((column) => literal(row[column])).join(", ")})`
    const bytes = Buffer.byteLength(value) + 2
    if (values.length && (size + bytes > STATEMENT_MAX || values.length >= ROWS_MAX)) flush()
    values.push(value)
    size += bytes
  }
  flush()
  return statements
}

/**
 * Every vault's rows: `vaults` is `{vault, "vault-private", restricted}`, the first two a folder of
 * their work trees, `restricted` the restricted vaults' checkouts (`[{repo, prefix, dir}]`).
 */
export function importRows(vaults) {
  const logs = []
  const read = (repo, dir, prefix = "") => {
    const log = readLog(dir)
    if (!log) throw new Error(`${dir} is not in a git work tree`)
    logs.push({ repo, log, prefix })
  }
  for (const repo of ["vault", "vault-private"]) if (vaults[repo]) read(repo, vaults[repo])
  for (const { repo, dir, prefix } of vaults.restricted ?? []) read(repo, dir, prefix)
  const publicLog = logs.find((entry) => entry.repo === "vault")?.log
  const known = people(publicLog ? peopleRecords(publicLog.root) : [])
  return logs.flatMap(({ repo, log, prefix }) => changeRows(repo, log.commits, known, { prefix }))
}

/** The rows of commits D1 has none of yet (`recorded`: "<repo> <sha>", recordedCommits). */
export const unrecorded = (rows, recorded) =>
  rows.filter((row) => !recorded.has(`${row.repo} ${row.commit_sha}`))

// ---- the command line (the members deploy) ----

function wrangler(args, workerDir) {
  const bin = path.join(workerDir, "node_modules", ".bin", "wrangler")
  const run = spawnSync(bin, args, {
    cwd: workerDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (run.status !== 0)
    throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed:\n${run.stderr || run.stdout}`)
  return run.stdout
}

/** The commits D1 has rows for, as "<repo> <sha>". */
function recordedCommits(database, workerDir) {
  const out = wrangler(
    [
      "d1",
      "execute",
      database,
      "--remote",
      "--json",
      "--command",
      "SELECT DISTINCT repo || ' ' || commit_sha AS commit_key FROM changes WHERE commit_sha IS NOT NULL",
    ],
    workerDir,
  )
  const [answer] = JSON.parse(out.slice(out.indexOf("[")))
  return new Set((answer?.results ?? []).map((row) => row.commit_key))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const option = (name) => {
    const at = process.argv.indexOf(`--${name}`)
    return at > 0 ? process.argv[at + 1] : undefined
  }
  const repeated = (name) =>
    process.argv.flatMap((arg, at) => (arg === `--${name}` ? [process.argv[at + 1]] : []))
  const remote = process.argv.includes("--remote")
  const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "worker")
  const database = option("database") ?? "hafezi-members"
  const named = repeated("restricted")
  const all = importRows({
    vault: option("vault"),
    "vault-private": option("vault-private"),
    restricted: restrictedDirs(
      named.length ? named.join(",") : (process.env.VAULT_RESTRICTED_DIRS ?? ""),
    ),
  })
  const recorded = remote ? recordedCommits(database, workerDir) : new Set()
  const rows = unrecorded(all, recorded)
  const statements = insertStatements(rows)
  const sql = option("sql")
  if (sql) fs.writeFileSync(sql, statements.map((statement) => statement + "\n").join(""))
  if (remote)
    for (const statement of statements)
      wrangler(["d1", "execute", database, "--remote", "--command", statement], workerDir)
  console.log(
    `changes: ${all.length} files changed in the vaults' commits, ${rows.length} not in D1 yet` +
      (remote ? `: sent to ${database} in ${statements.length} statements` : ""),
  )
}
