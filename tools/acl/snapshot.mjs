// The access rules the members build applies: the Worker's snapshot of its rules and groups, which
// the deploy exports from D1 (tools/acl/export-snapshot.mjs) to the file ACL_SNAPSHOT names
// (tools/acl/policy.mjs has their semantics). Never from vault-private, which every member can push
// to, in CI; a local build without ACL_SNAPSHOT falls back to a checkout's .hafezi/acl.json. A page
// some rule matches is restricted: the build marks it `unlisted: true` (so Quartz's own listings,
// backlinks, tags and search index leave it out) and `acl: <rule id>` (so the build's listings tag
// it with data-acl, and its search index entry goes to that rule's shard), and the Worker serves it
// only to members that rule lets read it.
import fs from "node:fs"
import path from "node:path"
import { aclKey, normalizeSnapshot } from "./policy.mjs"

export const SNAPSHOT_FILE = ".hafezi/acl.json"

/** Whether the build runs in CI, where only ACL_SNAPSHOT is trusted. */
export const inCI = (env) => env.CI === "true" || env.GITHUB_ACTIONS === "true"

/**
 * The snapshot file this build reads: `{file, warning}`. ACL_SNAPSHOT names it (it must exist). In
 * CI nothing else will do. A local build without it reads the private vault checkout's
 * .hafezi/acl.json, saying so (`file` null when that has none: no rules).
 */
export function snapshotSource(env, privateRoot) {
  if (env.ACL_SNAPSHOT) {
    if (!fs.existsSync(env.ACL_SNAPSHOT))
      throw new Error(`ACL_SNAPSHOT: no access rules snapshot at ${env.ACL_SNAPSHOT}`)
    return { file: env.ACL_SNAPSHOT, warning: null }
  }
  if (inCI(env))
    throw new Error(
      "ACL_SNAPSHOT must name the access rules snapshot exported from D1 " +
        "(tools/acl/export-snapshot.mjs): in CI the build never reads them from vault-private",
    )
  const file = path.join(privateRoot, SNAPSHOT_FILE)
  const found = fs.existsSync(file)
  return {
    file: found ? file : null,
    warning:
      `access rules: ACL_SNAPSHOT is not set; this local build reads ${found ? file : "no rules"}` +
      (found ? "" : ` (no ${SNAPSHOT_FILE} in ${privateRoot})`),
  }
}

/** The snapshot in `file`; none (no rules) without a file. */
export function readSnapshot(file) {
  if (!file) return normalizeSnapshot(undefined)
  try {
    return normalizeSnapshot(JSON.parse(fs.readFileSync(file, "utf8")))
  } catch (error) {
    throw new Error(`${file}: not a valid access rules snapshot (${error.message})`)
  }
}

/**
 * Every file of a restricted vault (`overlay`: `[{repo, path}]`, tools/acl/vaults.mjs) must be
 * covered by a rule: a restricted vault is never every member's by accident.
 */
export function checkCoverage(snapshot, overlay) {
  const open = overlay.filter((file) => aclKey(snapshot, file.path) === null)
  if (open.length)
    throw new Error(
      `restricted vault files not covered by an access rule:\n` +
        open.map((file) => `  ${file.repo}: ${file.path}`).join("\n"),
    )
}

/** The acl key of a folder of the vault ("projects/optical-rl"): its own path, as "dir/". */
export const folderAcl = (snapshot, folder) =>
  folder ? aclKey(snapshot, folder.replace(/\/?$/, "/")) : null

/**
 * The vault path of a staged private page (`fm` its front matter, `relative` its path under the
 * stage's resources/): its own file, which a Quarto or notebook page names as rendered_from.
 */
export function pageVaultPath(fm, relative) {
  if (typeof fm?.vault_source === "string") return fm.vault_source
  if (typeof fm?.rendered_from === "string") return fm.rendered_from.replace(/^resources\//, "")
  return relative
}

/**
 * The page's front matter, marked when the page is restricted: `unlisted: true` and `acl: <rule>`.
 * Returns the acl key (null when no rule matches; the front matter is then left as it is).
 */
export function markPage(snapshot, fm, vaultPath) {
  const acl = aclKey(snapshot, vaultPath)
  if (acl) Object.assign(fm, { unlisted: true, acl })
  return acl
}

/** `static/acl-build.json`: the snapshot version this build applied (the admin UI compares it). */
export function writeBuildVersion(output, snapshot) {
  const file = path.join(output, "static", "acl-build.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ version: snapshot.version }))
  return file
}

const walk = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) =>
          entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
        )
    : []

/**
 * Mark every restricted page of the staged private vault (`output`/resources) that isn't marked
 * yet: the notebooks' pages, which the build makes after prepare-unified marked the others.
 * Returns the number of pages marked.
 */
export function markPages(output, snapshot, yaml) {
  if (!snapshot.rules.length) return 0
  const root = path.join(output, "resources")
  let marked = 0
  for (const file of walk(root).filter((name) => name.endsWith(".md"))) {
    const text = fs.readFileSync(file, "utf8")
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
    const fm = match ? (yaml.parse(match[1]) ?? {}) : {}
    if (fm.acl) continue
    const relative = path.relative(root, file).split(path.sep).join("/")
    if (!markPage(snapshot, fm, pageVaultPath(fm, relative))) continue
    fs.writeFileSync(file, `---\n${yaml.stringify(fm)}---\n` + text.slice(match?.[0].length ?? 0))
    marked++
  }
  return marked
}
