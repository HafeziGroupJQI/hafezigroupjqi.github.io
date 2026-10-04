import type { Env } from "./env"
import { HttpError } from "./http"
import list from "../vaults.json"

// The private vault's files come from more than one repository: vault-private holds most of them,
// and a restricted vault (one of its own on GitHub, readable by its project's people only) is
// mounted at a folder of it, e.g. HafeziGroupJQI/vault-optical-rl at projects/optical-rl/. A file's
// path in its repository is its path in the vault (the mount's folder included), and the site's
// build lays every restricted vault over vault-private (worker/vaults.json, which it reads too).
// The Worker's GitHub calls for a path (uploads, page edits, documents, history) go to the
// repository it is in, with the same tokens.

export interface VaultMount {
  /** The repository's name, beside vault-private in its organization. */
  repo: string
  /** The folder it is mounted at ("" for vault-private itself), ending in "/". */
  prefix: string
}

export const VAULTS: readonly VaultMount[] = list
export const PRIVATE_VAULT: VaultMount = VAULTS.find((vault) => vault.prefix === "")!

/** The vault a path of the private vault is in: the mount with the longest prefix it starts with. */
export function vaultOf(path: string): VaultMount {
  let best = PRIVATE_VAULT
  for (const vault of VAULTS)
    if (vault.prefix && path.startsWith(vault.prefix) && vault.prefix.length > best.prefix.length)
      best = vault
  return best
}

/** The vault a folder ("projects/optical-rl", no trailing slash) is in. */
export const vaultOfFolder = (folder: string) => vaultOf(folder ? `${folder}/` : "")

/** A vault by its repository's name, or null. */
export const vaultNamed = (repo: string) => VAULTS.find((vault) => vault.repo === repo) ?? null

/** A vault's "owner/name" on GitHub: vault-private is DOCS_REPO, the others are beside it. */
export function vaultRepo(env: Pick<Env, "DOCS_REPO">, vault: VaultMount): string {
  const base = env.DOCS_REPO || "HafeziGroupJQI/vault-private"
  return vault.prefix ? `${base.split("/")[0]}/${vault.repo}` : base
}

/**
 * The one vault all these paths are in. A draft is one commit and one pull request, in one
 * repository, so a change set can't hold files of two vaults.
 */
export function oneVault(paths: (string | null | undefined)[]): VaultMount {
  const vaults = new Set(paths.filter((path): path is string => Boolean(path)).map(vaultOf))
  if (vaults.size > 1)
    throw new HttpError(
      422,
      `${[...vaults]
        .map((vault) => vault.prefix || "the rest of the vault")
        .join(" and ")} are kept apart: change each in a draft of its own`,
    )
  return [...vaults][0] ?? PRIVATE_VAULT
}

/** The restricted vaults mounted right inside a folder, as folder entries of it. */
export function mountsIn(folder: string): { name: string; path: string; vault: VaultMount }[] {
  const at = folder ? `${folder}/` : ""
  return VAULTS.filter(
    (vault) =>
      vault.prefix.startsWith(at) &&
      vault.prefix.length > at.length &&
      !vault.prefix.slice(at.length, -1).includes("/"),
  ).map((vault) => ({
    name: vault.prefix.slice(at.length, -1),
    path: vault.prefix.slice(0, -1),
    vault,
  }))
}
