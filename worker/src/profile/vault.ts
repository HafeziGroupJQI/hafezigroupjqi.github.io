import type { Env } from "../env"
import { type Author, GitRepo, type RepoFetch, type RepoFile } from "../repo"

// The public vault (VAULT_REPO) through GitHub's REST API, with a token that may write its
// contents (GITHUB_VAULT_TOKEN). People pages live at content/people/<slug>.md (alumni under
// content/people/alumni/), their photos at content/assets/people/. A push to the vault's main
// branch validates it and rebuilds both sites, so an edit shows on the People page a few minutes
// after it is committed.

/** Outbound fetch for the vault's GitHub API; tests substitute an in-memory repository. */
export type VaultFetch = RepoFetch
export type VaultFile = RepoFile
export type { Author }

export const PEOPLE_PAGE = /^content\/people\/(?:alumni\/)?([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/

export class Vault extends GitRepo {
  constructor(env: Env, fetcher: VaultFetch) {
    super(
      fetcher,
      env.VAULT_REPO || "HafeziGroupJQI/vault",
      env.GITHUB_VAULT_TOKEN,
      "profile editing is not set up yet: the site has no vault token",
    )
  }

  /** Every People page (current members and alumni), by path. */
  async peoplePages(tree: string): Promise<string[]> {
    const listing = await this.call<{ tree: Array<{ path: string; type: string }> }>(
      "GET",
      `/git/trees/${tree}?recursive=1`,
    )
    return listing.tree
      .filter((entry) => entry.type === "blob" && PEOPLE_PAGE.test(entry.path))
      .map((entry) => entry.path)
      .filter((path) => !path.endsWith("/index.md"))
      .sort()
  }
}
