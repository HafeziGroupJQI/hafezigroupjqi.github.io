import type { Env } from "../env"
import { HttpError } from "../http"

// The public vault (VAULT_REPO) through GitHub's REST API, with a token that may write its
// contents (GITHUB_VAULT_TOKEN). People pages live at content/people/<slug>.md (alumni under
// content/people/alumni/), their photos at content/assets/people/. A push to the vault's main
// branch validates it and rebuilds both sites, so an edit shows on the People page a few minutes
// after it is committed.

const GITHUB_API = "https://api.github.com"
const USER_AGENT = "hafezi-members-worker"
const BRANCH = "main"

/** Outbound fetch for the vault's GitHub API; tests substitute an in-memory repository. */
export type VaultFetch = (input: string, init: RequestInit) => Promise<Response>

export const PEOPLE_PAGE = /^content\/people\/(?:alumni\/)?([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/

export interface VaultFile {
  path: string
  /** null deletes the file. */
  content: Uint8Array | string | null
}

export interface Author {
  name: string
  email: string
}

export class Vault {
  constructor(
    private env: Env,
    private fetcher: VaultFetch,
  ) {}

  get repo(): string {
    return this.env.VAULT_REPO || "HafeziGroupJQI/vault"
  }

  get ready(): boolean {
    return Boolean(this.env.GITHUB_VAULT_TOKEN)
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.env.GITHUB_VAULT_TOKEN)
      throw new HttpError(503, "profile editing is not set up yet: the site has no vault token")
    const response = await this.fetcher(`${GITHUB_API}/repos/${this.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.env.GITHUB_VAULT_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.status === 404) throw new VaultMissing(path)
    if (response.status === 409 || response.status === 422) throw new VaultConflict(path)
    if (!response.ok) {
      console.error(`vault ${method} ${path}: ${response.status}`)
      throw new HttpError(502, "GitHub did not accept the vault request; try again shortly")
    }
    return (await response.json()) as T
  }

  /** The commit and tree at the tip of main. */
  async head(): Promise<{ commit: string; tree: string }> {
    const ref = await this.call<{ object: { sha: string } }>("GET", `/git/ref/heads/${BRANCH}`)
    const commit = await this.call<{ tree: { sha: string } }>(
      "GET",
      `/git/commits/${ref.object.sha}`,
    )
    return { commit: ref.object.sha, tree: commit.tree.sha }
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

  /** A text file at main, or null when it does not exist. */
  async read(path: string): Promise<string | null> {
    try {
      const file = await this.call<{ content: string; encoding: string }>(
        "GET",
        `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${BRANCH}`,
      )
      return new TextDecoder().decode(fromBase64(file.content.replace(/\s/g, "")))
    } catch (error) {
      if (error instanceof VaultMissing) return null
      throw error
    }
  }

  /**
   * One commit on main with every file in `files`. `build` reads what it needs at the current tip
   * and returns the files and message, so a concurrent push (the ref moved) is retried on top of
   * it, once. With `skipEmpty`, a build with no files commits nothing and returns null.
   */
  async commit(
    author: Author,
    build: () => Promise<{ files: VaultFile[]; message: string }>,
    { skipEmpty = false } = {},
  ): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      const tip = await this.head()
      const { files, message } = await build()
      if (!files.length) {
        if (skipEmpty) return null
        throw new Error("a vault commit needs at least one file")
      }
      const tree = await this.call<{ sha: string }>("POST", "/git/trees", {
        base_tree: tip.tree,
        tree: await Promise.all(
          files.map(async (file) => ({
            path: file.path,
            mode: "100644",
            type: "blob",
            sha: file.content === null ? null : await this.blob(file.content),
          })),
        ),
      })
      const commit = await this.call<{ sha: string }>("POST", "/git/commits", {
        message,
        tree: tree.sha,
        parents: [tip.commit],
        author: { ...author, date: new Date().toISOString() },
      })
      try {
        await this.call("PATCH", `/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false })
        return commit.sha
      } catch (error) {
        if (!(error instanceof VaultConflict) || attempt > 0) throw error
      }
    }
  }

  private async blob(content: Uint8Array | string): Promise<string> {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content
    const blob = await this.call<{ sha: string }>("POST", "/git/blobs", {
      content: toBase64(bytes),
      encoding: "base64",
    })
    return blob.sha
  }
}

class VaultMissing extends HttpError {
  constructor(path: string) {
    super(404, `not in the vault: ${path}`)
  }
}

class VaultConflict extends HttpError {
  constructor(path: string) {
    super(409, `the vault changed while saving (${path}); try again`)
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
