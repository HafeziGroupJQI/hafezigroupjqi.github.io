import type { Env } from "../env"
import { HttpError } from "../http"
import { GitRepo, type ListEntry, type RepoFetch } from "../repo"

// vault-private (DOCS_REPO) with a token that may write it (GITHUB_VAULT_PRIVATE_TOKEN: a
// fine-grained token on that repository alone with Contents and Pull requests read/write and
// Commit statuses read). Members' uploads become a branch and a pull request there; the hourly
// cron reads the commit status vault-private's validate workflow reports on the pull request's
// head (a fine-grained token can't read check runs) and merges it by rebase when it is green, so
// the member's own commit lands on main and the vault's history credits them, not the token.

/** The commit status context vault-private's validate workflow reports on a pull request. */
export const CHECK = "validate"

export interface Pull {
  number: number
  node_id: string
  html_url: string
  state: "open" | "closed"
  draft: boolean
  merged: boolean
  /** null while GitHub is still working it out. */
  mergeable: boolean | null
  merge_commit_sha: string | null
  head: { sha: string; ref: string }
}

export interface Check {
  state: "pending" | "success" | "failure" | "error"
  url: string | null
  description: string | null
}

export class PrivateVault extends GitRepo {
  constructor(env: Env, fetcher: RepoFetch) {
    super(
      fetcher,
      env.DOCS_REPO || "HafeziGroupJQI/vault-private",
      env.GITHUB_VAULT_PRIVATE_TOKEN,
      "uploads are not set up yet: the site has no token for vault-private",
    )
  }

  /** A file or folder at main by its path, and any other entry beside it whose name differs only
   *  in case (the vault is checked out on Windows and macOS too). */
  async entry(path: string): Promise<{ found: ListEntry | null; clash: string | null }> {
    const slash = path.lastIndexOf("/")
    const name = path.slice(slash + 1)
    const listing = (await this.list(path.slice(0, slash))) ?? []
    const found = listing.find((entry) => entry.name === name) ?? null
    const clash =
      listing.find(
        (entry) => entry.name !== name && entry.name.toLowerCase() === name.toLowerCase(),
      )?.name ?? null
    return { found, clash }
  }

  async pull(number: number): Promise<Pull> {
    return this.call<Pull>("GET", `/pulls/${number}`)
  }

  async openPull(fields: { title: string; body: string; head: string }): Promise<Pull> {
    return this.call<Pull>("POST", "/pulls", { ...fields, base: "main", draft: true })
  }

  async updatePull(
    number: number,
    fields: { title?: string; body?: string; state?: "open" | "closed" },
  ): Promise<Pull> {
    return this.call<Pull>("PATCH", `/pulls/${number}`, fields)
  }

  /** The validate workflow's status on a commit, or null before it has reported one. */
  async check(sha: string): Promise<Check | null> {
    const combined = await this.call<{
      statuses: {
        context: string
        state: Check["state"]
        target_url: string | null
        description: string | null
      }[]
    }>("GET", `/commits/${sha}/status`)
    const status = combined.statuses.find((s) => s.context === CHECK)
    return status
      ? { state: status.state, url: status.target_url, description: status.description }
      : null
  }

  /** A draft pull request can't be merged; only GraphQL turns one into a ready one. */
  async markReady(pull: Pull): Promise<void> {
    const response = await this.request(
      "POST",
      "/graphql",
      JSON.stringify({
        query:
          "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
        variables: { id: pull.node_id },
      }),
      { url: "https://api.github.com/graphql" },
    )
    const answer = await this.answer<{ errors?: { message: string }[] }>(
      response,
      "POST",
      "/graphql",
    )
    if (answer?.errors?.length) {
      console.error(`${this.repo} graphql: ${answer.errors.map((e) => e.message).join("; ")}`)
      throw new HttpError(502, "GitHub did not mark the pull request ready")
    }
  }

  /**
   * Merge a pull request by rebase, only if its head is still `sha` (the commit whose check
   * passed): its one commit goes onto main as the member made it, their name and message and all
   * (GitHub is only its committer). Returns main's new tip, or why GitHub refused.
   */
  async merge(number: number, sha: string): Promise<{ merged: string } | { refused: string }> {
    const response = await this.request(
      "PUT",
      `/pulls/${number}/merge`,
      JSON.stringify({ merge_method: "rebase", sha }),
    )
    if (response.ok) return { merged: ((await response.json()) as { sha: string }).sha }
    if ([405, 409, 422].includes(response.status)) {
      const reason = ((await response.json().catch(() => ({}))) as { message?: string }).message
      return { refused: reason || `GitHub refused the merge (${response.status})` }
    }
    return this.answer(response, "PUT", `/pulls/${number}/merge`)
  }
}
