// The private vault's restricted vaults: repositories readable only by some members (GitHub teams),
// each mounted at its prefix of vault-private's tree (worker/vaults.json, which the Worker reads
// too). A restricted vault keeps vault-private's layout under its prefix (its repo path is its vault
// path), and the members build copies its files onto vault-private before anything else, from the
// checkouts VAULT_RESTRICTED_DIRS names: "vault-optical-rl=/abs/checkout[,name=dir…]".
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const VAULTS_FILE = fileURLToPath(new URL("../../worker/vaults.json", import.meta.url))
export const PRIVATE_REPO = "vault-private"

/** The vaults: `[{repo, prefix}]`, vault-private's prefix "" and every other one a folder's. */
export function readVaults(file = VAULTS_FILE) {
  const vaults = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!Array.isArray(vaults) || !vaults.some((vault) => vault.repo === PRIVATE_REPO))
    throw new Error(`${file}: the vaults must list ${PRIVATE_REPO}`)
  for (const { repo, prefix } of vaults)
    if (typeof repo !== "string" || typeof prefix !== "string")
      throw new Error(`${file}: every vault needs a repo and a prefix`)
    else if (repo !== PRIVATE_REPO && !/^(?:[^/.][^/]*\/)+$/.test(prefix))
      throw new Error(`${file}: ${repo}'s prefix must be a folder ("dir/"), not "${prefix}"`)
  return vaults
}

/** The vault a vault path belongs to: the one with the longest matching prefix. */
export const vaultOf = (vaults, vaultPath) =>
  vaults
    .filter((vault) => vaultPath.startsWith(vault.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]?.repo ?? PRIVATE_REPO

/**
 * The restricted vaults' checkouts this build overlays: `[{repo, prefix, dir}]` from a
 * VAULT_RESTRICTED_DIRS value ("repo=dir,…"; empty: none). Each repo must be a restricted vault of
 * `vaults`, named once, with a checkout that exists.
 */
export function restrictedDirs(value, vaults = readVaults()) {
  const out = []
  for (const item of String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const at = item.indexOf("=")
    const repo = at > 0 ? item.slice(0, at).trim() : ""
    const dir = at > 0 ? item.slice(at + 1).trim() : ""
    const vault = vaults.find((entry) => entry.repo === repo)
    if (!repo || !dir) throw new Error(`VAULT_RESTRICTED_DIRS: "${item}" is not repo=dir`)
    if (!vault || repo === PRIVATE_REPO)
      throw new Error(
        `VAULT_RESTRICTED_DIRS: ${repo} is not a restricted vault (worker/vaults.json)`,
      )
    if (out.some((entry) => entry.repo === repo))
      throw new Error(`VAULT_RESTRICTED_DIRS: ${repo} is named twice`)
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
      throw new Error(`VAULT_RESTRICTED_DIRS: ${repo}'s checkout ${dir} is not a folder`)
    out.push({ repo, prefix: vault.prefix, dir: fs.realpathSync(dir) })
  }
  return out
}

/** Whether the build copies a vault file: no dotted segment, and no segment it excludes. */
export const isVaultFile = (file, excluded = new Set()) =>
  !file.split("/").some((segment) => segment.startsWith(".") || excluded.has(segment))

const walk = (dir, base = dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".")) return []
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(file, base)
    return [path.relative(base, file).split(path.sep).join("/")]
  })

/**
 * The files the build overlays onto vault-private at `privateRoot`: `[{repo, path, file}]`, path the
 * vault path, file the checkout's file. Throws when a restricted vault has a file outside its
 * prefix, or one that vault-private (or another restricted vault) already has.
 */
export function overlayFiles(restricted, privateRoot, { excluded = new Set() } = {}) {
  const out = []
  const seen = new Map()
  for (const { repo, prefix, dir } of restricted) {
    for (const vaultPath of walk(dir)
      .filter((file) => isVaultFile(file, excluded))
      .sort()) {
      if (!vaultPath.startsWith(prefix))
        throw new Error(`${repo}: ${vaultPath} is outside the vault's folder ${prefix}`)
      if (fs.existsSync(path.join(privateRoot, vaultPath)))
        throw new Error(`${repo}: ${vaultPath} is in ${PRIVATE_REPO} too`)
      if (seen.has(vaultPath))
        throw new Error(`${repo}: ${vaultPath} is in ${seen.get(vaultPath)} too`)
      seen.set(vaultPath, repo)
      out.push({ repo, path: vaultPath, file: path.join(dir, vaultPath) })
    }
  }
  return out
}

/**
 * A restricted vault's Wolfram notebooks can't be built yet: their renders come from the deploy's
 * notebooks job on the compute host, whose artifact must hold no restricted content. (Jupyter
 * notebooks and Quarto documents render in the build itself.)
 */
export function checkSupported(files) {
  const notebooks = files.filter((file) => /\.nb$/i.test(file.path))
  if (notebooks.length)
    throw new Error(
      "restricted Wolfram notebooks are not supported yet:\n" +
        notebooks.map((file) => `  ${file.repo}: ${file.path}`).join("\n"),
    )
}

/** Copy the overlay's files into `target` (a copy of vault-private's tree). */
export function applyOverlay(files, target) {
  for (const { path: vaultPath, file } of files) {
    const to = path.join(target, vaultPath)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(file, to)
  }
}
